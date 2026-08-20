import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerEnvironmentAdapterDescriptor,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from './environmentAdapter.js';
import { ComputerEnvironmentRegistry } from './environmentRegistry.js';
import { snapshotComputerTaskProgram, type ComputerTaskProgram } from './computerTask.js';
import {
  createComputerTaskCheckpoint,
  type ComputerTaskActionCheckpointState,
  type ComputerTaskCheckpoint,
  type ComputerTaskCheckpointUncertainty,
} from './computerTaskCheckpoint.js';
import type {
  ComputerTaskCheckpointPersistence,
  ComputerTaskCheckpointPersistenceBinding,
} from './computerTaskCheckpointPersistence.js';
import {
  ComputerTaskRuntime,
  type ComputerTaskReconciliationAssessment,
  type ComputerTaskReconciliationCase,
  type ComputerTaskReconciliationResolution,
  type ComputerTaskRunResult,
  type ComputerTaskRuntimeHooks,
} from './computerTaskRuntime.js';

export interface DurableComputerTaskRuntimeOptions {
  executionId: string;
  hooks?: ComputerTaskRuntimeHooks;
}

const PERSISTENCE_FAILURE = 'checkpoint-persist-failed';
const RECONCILIATION_DISPATCH_BLOCKED = 'reconciliation-dispatch-blocked';

function persistenceFailureResult(): ComputerActionResult {
  return Object.freeze({
    status: 'failed' as const,
    dispatch: 'not-dispatched' as const,
    verification: 'unverified' as const,
    evidence: Object.freeze([PERSISTENCE_FAILURE]),
  });
}

function reconciliationDispatchBlockedResult(): ComputerActionResult {
  return Object.freeze({
    status: 'rejected' as const,
    dispatch: 'not-dispatched' as const,
    verification: 'unverified' as const,
    evidence: Object.freeze([RECONCILIATION_DISPATCH_BLOCKED]),
  });
}

function addResultEvidence(result: ComputerTaskRunResult, code: string): ComputerTaskRunResult {
  const accepted = [...(result.evidence ?? [])];
  if (!accepted.includes(code) && accepted.length < 32) accepted.push(code);
  return {
    ...result,
    evidence: accepted.length ? Object.freeze(accepted) : undefined,
  };
}

/** Registry facade that inserts a durable write-ahead boundary immediately before adapter dispatch. */
class WriteAheadComputerEnvironmentRegistry extends ComputerEnvironmentRegistry {
  private reconciliationAssessmentDepth = 0;

  constructor(
    private readonly inner: ComputerEnvironmentRegistry,
    private readonly beforeAction: (request: ComputerActionRequest) => Promise<boolean>,
  ) {
    super();
  }

  enterReconciliationAssessment(): void { this.reconciliationAssessmentDepth += 1; }
  leaveReconciliationAssessment(): void { this.reconciliationAssessmentDepth = Math.max(0, this.reconciliationAssessmentDepth - 1); }

  register(adapter: ComputerEnvironmentAdapter): void { this.inner.register(adapter); }
  unregister(adapterId: string): boolean { return this.inner.unregister(adapterId); }
  descriptor(adapterId: string): ComputerEnvironmentAdapterDescriptor | undefined { return this.inner.descriptor(adapterId); }
  descriptors(): ComputerEnvironmentAdapterDescriptor[] { return this.inner.descriptors(); }
  observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> { return this.inner.observe(request); }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    if (this.reconciliationAssessmentDepth > 0) return reconciliationDispatchBlockedResult();
    if (!await this.beforeAction(request)) return persistenceFailureResult();
    return this.inner.act(request);
  }
}

/**
 * Persistence-aware coordinator around the neutral ComputerTaskRuntime.
 *
 * Before every adapter invocation it durably writes a pessimistic `unknown-dispatch`
 * checkpoint. Therefore a crash after invocation but before the post-run checkpoint
 * cannot expose an older replayable `not-started` state. Persistence remains an
 * injected storage-neutral interface; the runtime itself contains no file semantics.
 */
export class DurableComputerTaskRuntime {
  private writeAheadArmed = false;
  private operationTail: Promise<void> = Promise.resolve();
  private pendingOperations = 0;

  private constructor(
    private readonly runtime: ComputerTaskRuntime,
    private readonly guardedRegistry: WriteAheadComputerEnvironmentRegistry,
    private readonly persistence: ComputerTaskCheckpointPersistence,
    private readonly binding: ComputerTaskCheckpointPersistenceBinding,
  ) {}

  static async create(
    program: ComputerTaskProgram,
    registry: ComputerEnvironmentRegistry,
    persistence: ComputerTaskCheckpointPersistence,
    options: DurableComputerTaskRuntimeOptions,
  ): Promise<DurableComputerTaskRuntime> {
    const snapshot = snapshotComputerTaskProgram(program);
    const binding = Object.freeze({ program: snapshot, executionId: options.executionId });
    const checkpoint = await persistence.load(binding);
    let runtime!: ComputerTaskRuntime;
    let coordinator!: DurableComputerTaskRuntime;

    const guardedRegistry = new WriteAheadComputerEnvironmentRegistry(registry, async (request) => {
      const current = runtime.checkpoint();
      if (current.cursor.nextStepId !== request.actionId) return false;
      if (current.actions.find((action) => action.stepId === request.actionId)?.state !== 'not-started') return false;
      const actions = new Map<string, ComputerTaskActionCheckpointState>(
        current.actions.map((action) => [action.stepId, action.state]),
      );
      const uncertainties = new Map<string, ComputerTaskCheckpointUncertainty>(
        current.actions
          .filter((action) => action.uncertainty !== undefined)
          .map((action) => [action.stepId, action.uncertainty!] as const),
      );
      actions.set(request.actionId, 'unknown-dispatch');
      uncertainties.delete(request.actionId);
      const pessimistic = createComputerTaskCheckpoint({
        program: snapshot,
        executionId: options.executionId,
        nextStepId: current.cursor.nextStepId,
        stepsExecuted: current.cursor.stepsExecuted + 1,
        actions,
        uncertainties,
      });
      try {
        await persistence.save(pessimistic, binding);
        coordinator.writeAheadArmed = true;
        return true;
      } catch {
        return false;
      }
    });

    runtime = new ComputerTaskRuntime(snapshot, guardedRegistry, {
      executionId: options.executionId,
      checkpoint,
      hooks: options.hooks,
    });
    coordinator = new DurableComputerTaskRuntime(runtime, guardedRegistry, persistence, binding);
    return coordinator;
  }

  private assertIdle(operation: string): void {
    if (this.pendingOperations > 0) throw new Error(`cannot ${operation} while durable runtime operation is pending`);
  }

  checkpoint(): ComputerTaskCheckpoint {
    this.assertIdle('read checkpoint');
    return this.runtime.checkpoint();
  }

  pendingReconciliations(): readonly ComputerTaskReconciliationCase[] {
    this.assertIdle('read reconciliation state');
    return this.runtime.pendingReconciliations();
  }

  private async assessReconciliationNow(stepId: string): Promise<ComputerTaskReconciliationAssessment> {
    this.guardedRegistry.enterReconciliationAssessment();
    try {
      return await this.runtime.assessReconciliation(stepId);
    } finally {
      this.guardedRegistry.leaveReconciliationAssessment();
    }
  }

  assessReconciliation(stepId: string): Promise<ComputerTaskReconciliationAssessment> {
    return this.enqueueOperation(() => this.assessReconciliationNow(stepId));
  }

  resolveReconciliation(stepId: string, resolution: ComputerTaskReconciliationResolution): void {
    this.assertIdle('resolve reconciliation');
    this.runtime.resolveReconciliation(stepId, resolution);
  }

  private async persistCheckpointNow(): Promise<void> {
    await this.persistence.save(this.runtime.checkpoint(), this.binding);
    this.writeAheadArmed = false;
  }

  persistCheckpoint(): Promise<void> {
    return this.enqueueOperation(() => this.persistCheckpointNow());
  }

  private enqueueOperation<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingOperations += 1;
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => { release = resolve; });
    return previous.then(operation).finally(() => {
      this.pendingOperations -= 1;
      release();
    });
  }

  private async runOnce(): Promise<ComputerTaskRunResult> {
    const result = await this.runtime.run();
    try {
      await this.persistCheckpointNow();
      return result;
    } catch {
      const failed = addResultEvidence(result, PERSISTENCE_FAILURE);
      if (this.writeAheadArmed || result.status === 'reconciliation-required') {
        return { ...failed, status: 'reconciliation-required' };
      }
      return { ...failed, status: 'failed' };
    }
  }

  run(): Promise<ComputerTaskRunResult> {
    return this.enqueueOperation(() => this.runOnce());
  }
}
