import {
  computerActionMayAutoRetry,
  computerEffectRequiresApproval,
  sameComputerEntity,
  sameComputerSurface,
  type ComputerActionResult,
  type ComputerEntityRef,
  type ComputerObservationEnvelope,
  type ComputerSurfaceRef,
  type ComputerVerificationState,
} from './environmentAdapter.js';
import { ComputerEnvironmentRegistry } from './environmentRegistry.js';
import {
  normalizeComputerTaskObservationRequest,
  snapshotComputerTaskProgram,
  type ComputerTaskActionStep,
  type ComputerTaskProgram,
  type ComputerTaskStep,
} from './computerTask.js';
import {
  createComputerTaskCheckpoint,
  encodeComputerTaskCheckpoint,
  validateComputerTaskCheckpoint,
  type ComputerTaskActionCheckpointState,
  type ComputerTaskCheckpoint,
} from './computerTaskCheckpoint.js';
import {
  loadComputerTaskCheckpointStoreHead,
  type ComputerTaskCheckpointStore,
} from './computerTaskCheckpointStore.js';

export const COMPUTER_TASK_MAX_RETAINED_OBSERVATIONS = 64;
const EVIDENCE_CODE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const VERIFICATION_STATES: readonly ComputerVerificationState[] = [
  'not-applicable',
  'verified',
  'pending',
  'rejected',
  'mismatch',
  'unverified',
];

export type ComputerTaskTerminalStatus =
  | 'completed'
  | 'rejected'
  | 'unsupported'
  | 'failed'
  | 'stale-target'
  | 'verification-pending'
  | 'verification-mismatch'
  | 'unverified'
  | 'unknown-dispatch'
  | 'reconciliation-required'
  | 'suspended';

export interface ComputerTaskTargetRevalidation {
  state: 'fresh' | 'stale' | 'missing';
  surface?: ComputerSurfaceRef;
  entity?: ComputerEntityRef;
  evidence?: readonly string[];
}

export interface ComputerTaskVerificationDecision {
  state: ComputerVerificationState;
  evidence?: readonly string[];
}

export interface ComputerTaskApprovalContext {
  /** Immutable runtime-owned executable snapshot. */
  step: ComputerTaskActionStep;
}

export interface ComputerTaskVerificationContext {
  /** Immutable runtime-owned executable snapshot. */
  step: ComputerTaskActionStep;
  /** Immutable top-level snapshot; verifier mutation cannot alter runtime safety fields. */
  adapterResult: ComputerActionResult;
  registry: ComputerEnvironmentRegistry;
}

export interface ComputerTaskContinuationDecision {
  state: 'continue' | 'suspend';
  evidence?: readonly string[];
}

export interface ComputerTaskRuntimeHooks {
  /**
   * Trusted host continuation gate for long-horizon execution. Runs before any adapter preflight/dispatch.
   * Suspension preserves the current cursor and does not consume task budget.
   */
  continuationGate?: (context: { step: ComputerTaskStep; stepsExecuted: number }) => Promise<ComputerTaskContinuationDecision>;
  /**
   * Optional durable sink. For action steps the runtime writes a conservative pre-dispatch fence before
   * crossing the adapter boundary, then advances it only after verified state transitions.
   */
  checkpointSink?: (checkpoint: ComputerTaskCheckpoint) => Promise<void>;
  /** Must use bounded adapter/domain observations; raw observations are not retained by the runtime. */
  revalidateTarget?: (
    registry: ComputerEnvironmentRegistry,
    step: ComputerTaskActionStep,
  ) => Promise<ComputerTaskTargetRevalidation>;
  approve?: (context: ComputerTaskApprovalContext) => Promise<boolean>;
  verifiers?: Readonly<Record<string, (context: ComputerTaskVerificationContext) => Promise<ComputerTaskVerificationDecision>>>;
}

export interface ComputerTaskRuntimeOptions {
  executionId: string;
  checkpoint?: ComputerTaskCheckpoint;
  /** Strong durable anti-rollback store. Resume callers must supply the revision paired with checkpoint. */
  checkpointStore?: ComputerTaskCheckpointStore;
  /** 0 only for a new execution with no durable head; positive revisions must come from the store head. */
  checkpointStoreRevision?: number;
  /**
   * Non-secret opaque bindings for state that must remain stable across a long-horizon resume,
   * e.g. authenticated-account/session generation, authority revision, tenant, or environment generation.
   */
  resumeContext?: Readonly<Record<string, string>>;
  hooks?: ComputerTaskRuntimeHooks;
}

/** Bounded metadata-only observation record. `data` is intentionally not retained. */
export interface ComputerTaskObservationRecord {
  adapterId: ComputerObservationEnvelope['adapterId'];
  environment: ComputerObservationEnvelope['environment'];
  channel: ComputerObservationEnvelope['channel'];
  sequence: number;
  complete: boolean;
  truncated: boolean;
  surface?: ComputerSurfaceRef;
  target?: ComputerEntityRef;
}

export interface ComputerTaskRunResult {
  status: ComputerTaskTerminalStatus;
  stepsExecuted: number;
  nextStepId?: string;
  evidence?: readonly string[];
  observations: readonly ComputerTaskObservationRecord[];
  observationsDropped: number;
}

function evidence(...groups: Array<readonly string[] | undefined>): string[] | undefined {
  const accepted: string[] = [];
  let invalid = false;
  for (const group of groups) {
    for (const code of group ?? []) {
      if (!EVIDENCE_CODE.test(code)) {
        invalid = true;
        continue;
      }
      if (!accepted.includes(code) && accepted.length < 32) accepted.push(code);
    }
  }
  if (invalid && accepted.length < 32 && !accepted.includes('runtime-evidence-invalid')) {
    accepted.push('runtime-evidence-invalid');
  }
  return accepted.length > 0 ? accepted : undefined;
}

function observationRecord(observation: ComputerObservationEnvelope): ComputerTaskObservationRecord {
  return Object.freeze({
    adapterId: observation.adapterId,
    environment: observation.environment,
    channel: observation.channel,
    sequence: observation.sequence,
    complete: observation.complete,
    truncated: observation.truncated,
    surface: observation.surface ? Object.freeze({ ...observation.surface }) : undefined,
    target: observation.target ? Object.freeze({ ...observation.target }) : undefined,
  });
}

function snapshotAdapterResult(result: ComputerActionResult): ComputerActionResult {
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('adapter result must be a plain object');
  if (Object.getOwnPropertySymbols(result).length > 0) throw new Error('adapter result contains symbol properties');
  const descriptors = Object.getOwnPropertyDescriptors(result);
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (descriptor.get || descriptor.set) throw new Error(`adapter result ${key} must be a data property`);
  }
  for (const key of ['status', 'dispatch', 'verification'] as const) {
    if (!descriptors[key] || !('value' in descriptors[key])) throw new Error(`adapter result ${key} must be an own data property`);
  }
  if (descriptors.evidence && !('value' in descriptors.evidence)) throw new Error('adapter result evidence must be a data property');
  if (descriptors.details && !('value' in descriptors.details)) throw new Error('adapter result details must be a data property');
  const rawEvidence = descriptors.evidence?.value as readonly string[] | undefined;
  return Object.freeze({
    status: descriptors.status.value as ComputerActionResult['status'],
    dispatch: descriptors.dispatch.value as ComputerActionResult['dispatch'],
    verification: descriptors.verification.value as ComputerActionResult['verification'],
    evidence: rawEvidence ? Object.freeze([...rawEvidence]) : undefined,
    details: descriptors.details?.value,
  });
}

function terminalFromVerification(state: ComputerVerificationState): ComputerTaskTerminalStatus | undefined {
  if (state === 'verified' || state === 'not-applicable') return undefined;
  if (state === 'pending') return 'verification-pending';
  if (state === 'mismatch' || state === 'rejected') return 'verification-mismatch';
  return 'unverified';
}

export class ComputerTaskRuntime {
  private readonly program: ComputerTaskProgram;
  private readonly registry: ComputerEnvironmentRegistry;
  private readonly executionId: string;
  private readonly hooks: ComputerTaskRuntimeHooks;
  private readonly resumeContext: Readonly<Record<string, string>>;
  private readonly checkpointStore: ComputerTaskCheckpointStore | undefined;
  private checkpointStoreRevision: number | undefined;
  private readonly stepById: Map<string, ComputerTaskStep>;
  private readonly actionStates = new Map<string, ComputerTaskActionCheckpointState>();
  private currentStepId: string | undefined;
  private stepsExecuted = 0;
  private unresolvedCheckpointDispatch = false;
  private observationsDropped = 0;

  constructor(
    program: ComputerTaskProgram,
    registry: ComputerEnvironmentRegistry,
    options: ComputerTaskRuntimeOptions,
  ) {
    this.program = snapshotComputerTaskProgram(program);
    this.registry = registry;
    this.executionId = options.executionId;
    if (!/^[0-9a-f]{32,64}$/.test(this.executionId)) {
      throw new Error('computer task execution id must be 32 to 64 lowercase hexadecimal characters');
    }
    this.hooks = Object.freeze({
      ...options.hooks,
      verifiers: options.hooks?.verifiers ? Object.freeze({ ...options.hooks.verifiers }) : undefined,
    });
    this.checkpointStore = options.checkpointStore;
    if (this.checkpointStore) {
      const revision = options.checkpointStoreRevision ?? (options.checkpoint ? undefined : 0);
      if (revision === undefined || !Number.isSafeInteger(revision) || revision < 0 || revision > 1_000_000_000 ||
          (options.checkpoint !== undefined && revision === 0) || (options.checkpoint === undefined && revision !== 0)) {
        throw new Error('computer task checkpoint store revision is invalid for runtime state');
      }
      this.checkpointStoreRevision = revision;
    } else if (options.checkpointStoreRevision !== undefined) {
      throw new Error('computer task checkpoint store revision requires a checkpoint store');
    }
    this.resumeContext = this.captureResumeContext(options.resumeContext);
    this.stepById = new Map(this.program.steps.map((step) => [step.id, step]));
    this.currentStepId = this.program.entry;

    if (options.checkpoint) {
      validateComputerTaskCheckpoint(options.checkpoint, {
        program: this.program,
        executionId: this.executionId,
        requireRuntimeProvenance: true,
      });
      this.assertResumeContext(options.checkpoint);
      this.currentStepId = options.checkpoint.cursor.nextStepId;
      this.stepsExecuted = options.checkpoint.cursor.stepsExecuted;
      for (const action of options.checkpoint.actions) {
        this.actionStates.set(action.stepId, action.state);
        if (action.state === 'unknown-dispatch' || action.state === 'dispatched-unverified') {
          this.unresolvedCheckpointDispatch = true;
        }
      }
    }
  }

  checkpoint(): ComputerTaskCheckpoint {
    return createComputerTaskCheckpoint({
      program: this.program,
      executionId: this.executionId,
      nextStepId: this.currentStepId,
      stepsExecuted: this.stepsExecuted,
      actions: this.actionStates,
      resumeContext: this.resumeContext,
    });
  }

  private captureResumeContext(value: Readonly<Record<string, string>> | undefined): Readonly<Record<string, string>> {
    if (value === undefined) return Object.freeze({});
    const entries = Object.entries(value);
    if (entries.length > 32) throw new Error('computer task resume context exceeds 32 bindings');
    const captured: Record<string, string> = Object.create(null);
    for (const [key, binding] of entries) {
      if (!/^[a-z0-9][a-z0-9._:-]{0,127}$/i.test(key) || typeof binding !== 'string' ||
          binding.length === 0 || new TextEncoder().encode(binding).byteLength > 256 || /[\r\n\0]/.test(binding)) {
        throw new Error('computer task resume context contains an invalid binding');
      }
      captured[key] = binding;
    }
    return Object.freeze(captured);
  }

  private assertResumeContext(checkpoint: ComputerTaskCheckpoint): void {
    const expected = new Map((checkpoint.resumeContext ?? []).map((binding) => [binding.key, binding.value]));
    const current = new Map(Object.entries(this.resumeContext));
    if (expected.size !== current.size) throw new Error('computer task checkpoint resume context mismatch');
    for (const [key, value] of expected) {
      if (current.get(key) !== value) throw new Error('computer task checkpoint resume context mismatch');
    }
  }

  private preflight(step: ComputerTaskStep): ComputerTaskRunResult | undefined {
    const descriptor = this.registry.descriptor(step.request.adapterId);
    if (!descriptor) return this.result('unsupported', [], ['adapter-not-found']);
    if (step.requirements?.environment && step.requirements.environment !== descriptor.kind) {
      return this.result('unsupported', [], ['environment-mismatch']);
    }
    const required = new Set(step.requirements?.capabilities ?? []);
    if (step.kind === 'action') required.add(step.request.capability);
    for (const capability of required) {
      if (!descriptor.capabilities.includes(capability)) return this.result('unsupported', [], ['capability-not-advertised']);
    }
    return undefined;
  }

  /** Current monotonic durable revision, when a CAS store is attached. */
  durableCheckpointRevision(): number | undefined {
    return this.checkpointStoreRevision;
  }

  private async checkpointStoreHeadIsCurrent(): Promise<boolean> {
    if (!this.checkpointStore) return true;
    try {
      const head = await loadComputerTaskCheckpointStoreHead(this.checkpointStore, this.executionId);
      const revision = head?.revision ?? 0;
      if (revision !== this.checkpointStoreRevision) return false;
      if (!head) return revision === 0;
      return encodeComputerTaskCheckpoint(head.checkpoint) === encodeComputerTaskCheckpoint(this.checkpoint());
    } catch {
      return false;
    }
  }

  private async persistCheckpoint(): Promise<boolean> {
    const checkpoint = this.checkpoint();
    if (this.checkpointStore) {
      const expectedRevision = this.checkpointStoreRevision;
      if (expectedRevision === undefined) return false;
      try {
        const committed = await this.checkpointStore.compareAndSwap(this.executionId, expectedRevision, checkpoint);
        if (!committed || committed.status !== 'committed' || committed.revision !== expectedRevision + 1) return false;
        this.checkpointStoreRevision = committed.revision;
      } catch {
        return false;
      }
    }
    if (!this.hooks.checkpointSink) return true;
    try {
      await this.hooks.checkpointSink(checkpoint);
      return true;
    } catch {
      return false;
    }
  }

  private async targetFresh(step: ComputerTaskActionStep): Promise<ComputerTaskTargetRevalidation> {
    if (!step.target) {
      return step.request.target
        ? { state: 'missing', evidence: ['target-freshness-binding-missing'] }
        : { state: 'fresh' };
    }
    const revalidate = this.hooks.revalidateTarget;
    if (!revalidate) return { state: 'missing', evidence: ['target-revalidator-required'] };
    const fresh = await revalidate(this.registry, step);
    if (fresh.state !== 'fresh') return { ...fresh, evidence: evidence(fresh.evidence) };
    if (step.target.surface && (!fresh.surface || !sameComputerSurface(step.target.surface, fresh.surface))) {
      return { state: 'stale', surface: fresh.surface, entity: fresh.entity, evidence: ['surface-generation-stale'] };
    }
    if (step.target.entity && (!fresh.entity || !sameComputerEntity(step.target.entity, fresh.entity))) {
      return { state: 'stale', surface: fresh.surface, entity: fresh.entity, evidence: ['entity-generation-stale'] };
    }
    return { ...fresh, evidence: evidence(fresh.evidence) };
  }

  private async verify(step: ComputerTaskActionStep, adapterResult: ComputerActionResult): Promise<ComputerTaskVerificationDecision> {
    if (step.verification) {
      const verifier = this.hooks.verifiers?.[step.verification];
      if (!verifier) return { state: 'unverified', evidence: ['verifier-not-found'] };
      const decision = await verifier({ step, adapterResult, registry: this.registry });
      if (!VERIFICATION_STATES.includes(decision.state)) {
        return { state: 'unverified', evidence: ['verifier-response-invalid'] };
      }
      return { state: decision.state, evidence: evidence(decision.evidence) };
    }
    return { state: adapterResult.verification, evidence: evidence(adapterResult.evidence) };
  }

  private recordDispatchBeforeVerification(stepId: string, adapterResult: ComputerActionResult): void {
    if (adapterResult.dispatch === 'unknown') {
      this.actionStates.set(stepId, 'unknown-dispatch');
    } else if (adapterResult.dispatch === 'dispatched-once') {
      this.actionStates.set(stepId, 'dispatched-unverified');
    } else {
      this.actionStates.set(stepId, 'not-started');
    }
  }

  private verifierFailureResult(adapterResult: ComputerActionResult): ComputerTaskRunResult {
    if (adapterResult.dispatch === 'unknown') {
      return this.result('unknown-dispatch', [], evidence(adapterResult.evidence, ['verifier-threw-after-dispatch']));
    }
    if (adapterResult.dispatch === 'dispatched-once') {
      return this.result('unverified', [], evidence(adapterResult.evidence, ['verifier-threw-after-dispatch']));
    }
    return this.result('unverified', [], evidence(adapterResult.evidence, ['verifier-threw']));
  }

  private async executeAction(step: ComputerTaskActionStep): Promise<{ result: ComputerTaskRunResult; next?: string }> {
    const prior = this.actionStates.get(step.id);
    if (prior === 'completed') return { result: this.result('completed', []), next: step.onSuccess };
    if (prior === 'unknown-dispatch' || prior === 'dispatched-unverified') {
      return { result: this.result('reconciliation-required', [], ['checkpoint-unresolved-dispatch']) };
    }
    this.actionStates.set(step.id, 'not-started');

    const firstFresh = await this.targetFresh(step);
    if (firstFresh.state !== 'fresh') {
      return { result: this.result('stale-target', [], evidence(firstFresh.evidence, ['target-not-fresh'])) };
    }

    if (computerEffectRequiresApproval(step.request.effect)) {
      const approved = this.hooks.approve ? await this.hooks.approve({ step }) : false;
      if (!approved) return { result: this.result('rejected', [], ['approval-denied']) };
    }

    let retries = 0;
    while (true) {
      const predispatch = await this.targetFresh(step);
      if (predispatch.state !== 'fresh') {
        return { result: this.result('stale-target', [], evidence(predispatch.evidence, ['target-changed-before-dispatch'])) };
      }
      if (this.hooks.checkpointSink || this.checkpointStore) {
        // Write-ahead fence: after this durable state exists, any crash/lost process must reconcile
        // rather than replaying the action from an older not-started checkpoint.
        this.actionStates.set(step.id, 'unknown-dispatch');
        if (!await this.persistCheckpoint()) {
          return { result: this.result('suspended', [], ['checkpoint-persistence-unknown-before-dispatch']) };
        }
      }
      const registryResult = await this.registry.act(step.request);
      let adapterResult: ComputerActionResult;
      try {
        adapterResult = snapshotAdapterResult(registryResult);
      } catch {
        this.actionStates.set(step.id, 'unknown-dispatch');
        return { result: this.result('unknown-dispatch', [], ['adapter-result-snapshot-invalid']) };
      }
      this.recordDispatchBeforeVerification(step.id, adapterResult);

      let verification: ComputerTaskVerificationDecision;
      try {
        verification = await this.verify(step, adapterResult);
      } catch {
        return { result: this.verifierFailureResult(adapterResult) };
      }

      const verificationStatus = terminalFromVerification(verification.state);
      const effectfulDispatchedWithoutVerification =
        step.request.effect !== 'observe-only' && adapterResult.dispatch === 'dispatched-once' && verification.state === 'not-applicable';

      if (adapterResult.status === 'completed') {
        if (effectfulDispatchedWithoutVerification) {
          return { result: this.result('unverified', [], evidence(adapterResult.evidence, ['post-dispatch-verification-required'])) };
        }
        if (verificationStatus) {
          return { result: this.result(verificationStatus, [], evidence(adapterResult.evidence, verification.evidence)) };
        }
        if (adapterResult.dispatch === 'unknown') {
          return { result: this.result('unknown-dispatch', [], evidence(adapterResult.evidence, verification.evidence)) };
        }
        this.actionStates.set(step.id, 'completed');
        return { result: this.result('completed', [], evidence(adapterResult.evidence, verification.evidence)), next: step.onSuccess };
      }

      const mayRetry = retries < (step.maxRetries ?? 0) && computerActionMayAutoRetry(step.request, adapterResult);
      if (mayRetry) {
        retries += 1;
        continue;
      }

      if (adapterResult.dispatch === 'unknown') {
        return { result: this.result('unknown-dispatch', [], evidence(adapterResult.evidence, verification.evidence)) };
      }
      if (adapterResult.status === 'unsupported') return { result: this.result('unsupported', [], adapterResult.evidence) };
      if (adapterResult.status === 'rejected') return { result: this.result('rejected', [], adapterResult.evidence) };
      if (adapterResult.status === 'failed' && adapterResult.dispatch === 'not-dispatched') {
        return { result: this.result('failed', [], adapterResult.evidence), next: step.onFailure };
      }
      if (verificationStatus) {
        return { result: this.result(verificationStatus, [], evidence(adapterResult.evidence, verification.evidence)) };
      }
      if (adapterResult.status === 'failed') {
        return { result: this.result('failed', [], adapterResult.evidence), next: step.onFailure };
      }
      return { result: this.result('failed', [], adapterResult.evidence) };
    }
  }

  async run(): Promise<ComputerTaskRunResult> {
    const observations: ComputerTaskObservationRecord[] = [];
    this.observationsDropped = 0;
    if (!await this.checkpointStoreHeadIsCurrent()) {
      return this.result('suspended', observations, ['checkpoint-store-head-mismatch']);
    }
    if (this.unresolvedCheckpointDispatch) {
      return this.result('reconciliation-required', observations, ['checkpoint-unresolved-dispatch']);
    }
    const maxTotalSteps = Math.max(1, this.program.steps.length * (4 + 3));

    while (this.currentStepId !== undefined) {
      // This budget is bound to the logical execution, not the current process/run call.
      // Checkpoint/resume therefore cannot manufacture fresh exploration/retry budget.
      if (this.stepsExecuted >= maxTotalSteps) return this.result('failed', observations, ['task-step-budget-exhausted']);
      const step = this.stepById.get(this.currentStepId);
      if (!step) return this.result('failed', observations, ['task-step-missing']);

      if (this.hooks.continuationGate) {
        let continuation: ComputerTaskContinuationDecision;
        try {
          continuation = await this.hooks.continuationGate({ step, stepsExecuted: this.stepsExecuted });
        } catch {
          return this.result('suspended', observations, ['continuation-gate-unknown']);
        }
        if (!continuation || (continuation.state !== 'continue' && continuation.state !== 'suspend')) {
          return this.result('suspended', observations, ['continuation-gate-invalid']);
        }
        if (continuation.state === 'suspend') {
          return this.result('suspended', observations, evidence(continuation.evidence, ['task-continuation-suspended']));
        }
      }

      const preflight = this.preflight(step);
      if (preflight) return { ...preflight, observations: Object.freeze([...observations]), observationsDropped: this.observationsDropped };

      if (step.kind === 'observe') {
        const observation = await this.registry.observe(normalizeComputerTaskObservationRequest(step.request));
        if (observations.length === COMPUTER_TASK_MAX_RETAINED_OBSERVATIONS) {
          observations.shift();
          this.observationsDropped += 1;
        }
        observations.push(observationRecord(observation));
        this.stepsExecuted += 1;
        this.currentStepId = step.next;
        if (!await this.persistCheckpoint()) return this.result('suspended', observations, ['checkpoint-persistence-failed-after-step']);
        continue;
      }

      const before = this.actionStates.get(step.id);
      const execution = await this.executeAction(step);
      const skippedKnownCompleted = before === 'completed';
      if (!skippedKnownCompleted) this.stepsExecuted += 1;
      if (execution.result.status === 'completed') {
        this.currentStepId = execution.next;
        if (!await this.persistCheckpoint()) return this.result('suspended', observations, ['checkpoint-persistence-failed-after-step']);
        continue;
      }
      if (execution.result.status === 'failed' && execution.next !== undefined) {
        this.currentStepId = execution.next;
        if (!await this.persistCheckpoint()) return this.result('suspended', observations, ['checkpoint-persistence-failed-after-step']);
        continue;
      }
      return {
        ...execution.result,
        stepsExecuted: this.stepsExecuted,
        nextStepId: this.currentStepId,
        observations: Object.freeze([...observations]),
        observationsDropped: this.observationsDropped,
      };
    }

    return this.result('completed', observations);
  }

  private result(
    status: ComputerTaskTerminalStatus,
    observations: readonly ComputerTaskObservationRecord[],
    resultEvidence?: readonly string[],
  ): ComputerTaskRunResult {
    return {
      status,
      stepsExecuted: this.stepsExecuted,
      nextStepId: this.currentStepId,
      evidence: evidence(resultEvidence),
      observations: Object.freeze([...observations]),
      observationsDropped: this.observationsDropped,
    };
  }
}
