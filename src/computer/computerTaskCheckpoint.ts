import { createHash, timingSafeEqual } from 'node:crypto';
import { validateComputerTaskProgram, type ComputerTaskProgram } from './computerTask.js';

export const COMPUTER_TASK_CHECKPOINT_VERSION = 1 as const;
export const COMPUTER_TASK_CHECKPOINT_FORMAT = 'browser-automation/computer-task-checkpoint' as const;
export const COMPUTER_TASK_CHECKPOINT_MAX_BYTES = 64 * 1024;
export const COMPUTER_TASK_CHECKPOINT_MAX_STEPS_EXECUTED = 1_000_000;
export const COMPUTER_TASK_CHECKPOINT_MAX_RESUME_BINDINGS = 32;
export const COMPUTER_TASK_CHECKPOINT_MAX_RESUME_BINDING_BYTES = 256;

export interface ComputerTaskResumeContextBinding {
  key: string;
  value: string;
}

export type ComputerTaskActionCheckpointState = 'not-started' | 'completed' | 'dispatched-unverified' | 'unknown-dispatch';

export interface ComputerTaskActionCheckpoint {
  stepId: string;
  state: ComputerTaskActionCheckpointState;
}

export interface ComputerTaskCheckpoint {
  version: typeof COMPUTER_TASK_CHECKPOINT_VERSION;
  program: { id: string; hash: string };
  execution: { id: string };
  cursor: {
    nextStepId?: string;
    stepsExecuted: number;
  };
  actions: readonly ComputerTaskActionCheckpoint[];
  /** Non-secret opaque bindings that must match exactly before long-horizon resume. */
  resumeContext?: readonly ComputerTaskResumeContextBinding[];
}

export interface ComputerTaskCheckpointValidationOptions {
  program?: ComputerTaskProgram;
  executionId?: string;
  /** Runtime resume accepts only checkpoints produced by this module's create/decode paths. */
  requireRuntimeProvenance?: boolean;
}

interface ComputerTaskCheckpointEnvelope {
  format: typeof COMPUTER_TASK_CHECKPOINT_FORMAT;
  integrity: { algorithm: 'sha256'; digest: string };
  payload: ComputerTaskCheckpoint;
}

const SHA256 = /^[0-9a-f]{64}$/;
const EXECUTION_ID = /^[0-9a-f]{32,64}$/;
const ACTION_STATES: readonly ComputerTaskActionCheckpointState[] = [
  'not-started',
  'completed',
  'dispatched-unverified',
  'unknown-dispatch',
];
const RESUME_BINDING_KEY = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const CHECKPOINT_PROVENANCE = Symbol('computer-task-checkpoint-provenance');
type ProvenancedCheckpoint = ComputerTaskCheckpoint & { readonly [CHECKPOINT_PROVENANCE]: true };

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('computer task checkpoint contains a non-finite number');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value !== 'object') throw new Error('computer task checkpoint contains a non-JSON value');
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().filter((key) => object[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`).join(',')}}`;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function boundedIdentifier(value: unknown, max = 256): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= max && !/[\r\n\0]/.test(value);
}

function programProjection(program: ComputerTaskProgram): unknown {
  return {
    id: program.id,
    entry: program.entry,
    steps: program.steps.map((step) => step.kind === 'observe' ? {
      kind: step.kind,
      id: step.id,
      adapterId: step.request.adapterId,
      channel: step.request.channel,
      requirements: step.requirements,
      surface: step.request.surface,
      target: step.request.target,
      limits: step.request.limits,
      next: step.next,
    } : {
      kind: step.kind,
      id: step.id,
      adapterId: step.request.adapterId,
      capability: step.request.capability,
      effect: step.request.effect,
      idempotency: step.request.idempotency,
      target: step.target,
      requirements: step.requirements,
      verification: step.verification,
      checkpointBinding: step.checkpointBinding,
      onSuccess: step.onSuccess,
      onFailure: step.onFailure,
      maxRetries: step.maxRetries,
      payloadPresent: step.request.payload !== undefined,
    }),
  };
}

/** Deterministic non-secret program identity. Raw action payloads are deliberately excluded. */
export function computerTaskProgramHash(program: ComputerTaskProgram): string {
  return sha256(canonicalJson(programProjection(program)));
}

function actionStepIds(program: ComputerTaskProgram): string[] {
  return program.steps.filter((step) => step.kind === 'action').map((step) => step.id).sort();
}

function cursorReachableUnderHistory(
  program: ComputerTaskProgram,
  checkpoint: ComputerTaskCheckpoint,
): boolean {
  const cursorId = checkpoint.cursor.nextStepId;
  if (!cursorId) return true;
  const stepById = new Map(program.steps.map((step) => [step.id, step]));
  const stateByAction = new Map(checkpoint.actions.map((action) => [action.stepId, action.state]));
  const requirePositivePath = checkpoint.cursor.stepsExecuted > 0;
  const queue: Array<{ stepId: string; moved: boolean }> = [{ stepId: program.entry, moved: false }];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    const seenKey = `${current.stepId}:${current.moved ? 1 : 0}`;
    if (seen.has(seenKey)) continue;
    seen.add(seenKey);

    if (current.stepId === cursorId && (!requirePositivePath || current.moved)) return true;
    const step = stepById.get(current.stepId);
    if (!step) continue;

    if (step.kind === 'observe') {
      if (step.next) queue.push({ stepId: step.next, moved: true });
      continue;
    }

    const state = stateByAction.get(step.id);
    if (state === 'completed') {
      if (step.onSuccess) queue.push({ stepId: step.onSuccess, moved: true });
      continue;
    }
    if (state === 'not-started' && step.onFailure) {
      // A definitely-not-dispatched failure may legitimately have followed onFailure
      // while leaving the action replay-safe. Treat that edge as history-reachable.
      queue.push({ stepId: step.onFailure, moved: true });
    }
  }
  return false;
}

function markCheckpointProvenance(checkpoint: ComputerTaskCheckpoint): ComputerTaskCheckpoint {
  const mutable = checkpoint as ProvenancedCheckpoint;
  Object.defineProperty(mutable, CHECKPOINT_PROVENANCE, {
    value: true,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return checkpoint;
}

function freezeCheckpoint(checkpoint: ComputerTaskCheckpoint): ComputerTaskCheckpoint {
  const frozen: ComputerTaskCheckpoint = {
    version: checkpoint.version,
    program: Object.freeze({ ...checkpoint.program }),
    execution: Object.freeze({ ...checkpoint.execution }),
    cursor: Object.freeze({ ...checkpoint.cursor }),
    actions: Object.freeze(checkpoint.actions.map((action) => Object.freeze({ ...action }))),
    resumeContext: checkpoint.resumeContext
      ? Object.freeze(checkpoint.resumeContext.map((binding) => Object.freeze({ ...binding })))
      : undefined,
  };
  markCheckpointProvenance(frozen);
  return Object.freeze(frozen);
}

export function validateComputerTaskCheckpoint(
  value: unknown,
  options: ComputerTaskCheckpointValidationOptions = {},
): asserts value is ComputerTaskCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid computer task checkpoint');
  const checkpoint = value as Partial<ComputerTaskCheckpoint>;
  if (options.requireRuntimeProvenance && (value as Partial<ProvenancedCheckpoint>)[CHECKPOINT_PROVENANCE] !== true) {
    throw new Error('computer task checkpoint lacks runtime provenance; use create/decode checkpoint APIs');
  }
  if (checkpoint.version !== COMPUTER_TASK_CHECKPOINT_VERSION) throw new Error('unsupported computer task checkpoint version');
  if (!checkpoint.program || !boundedIdentifier(checkpoint.program.id, 128) || !SHA256.test(checkpoint.program.hash)) {
    throw new Error('invalid computer task checkpoint program identity');
  }
  if (!checkpoint.execution || !EXECUTION_ID.test(checkpoint.execution.id)) throw new Error('invalid computer task checkpoint execution identity');
  if (
    !checkpoint.cursor ||
    !Number.isSafeInteger(checkpoint.cursor.stepsExecuted) ||
    checkpoint.cursor.stepsExecuted < 0 ||
    checkpoint.cursor.stepsExecuted > COMPUTER_TASK_CHECKPOINT_MAX_STEPS_EXECUTED
  ) {
    throw new Error('invalid computer task checkpoint cursor');
  }
  if (checkpoint.cursor.nextStepId !== undefined && !boundedIdentifier(checkpoint.cursor.nextStepId, 128)) {
    throw new Error('invalid computer task checkpoint cursor step');
  }
  if (!Array.isArray(checkpoint.actions) || checkpoint.actions.length > 512) throw new Error('invalid computer task checkpoint actions');
  if (checkpoint.resumeContext !== undefined) {
    if (!Array.isArray(checkpoint.resumeContext) || checkpoint.resumeContext.length > COMPUTER_TASK_CHECKPOINT_MAX_RESUME_BINDINGS) {
      throw new Error('invalid computer task checkpoint resume context');
    }
    const resumeKeys = new Set<string>();
    for (const binding of checkpoint.resumeContext) {
      if (!binding || typeof binding !== 'object' || !RESUME_BINDING_KEY.test(binding.key) ||
          !boundedIdentifier(binding.value, COMPUTER_TASK_CHECKPOINT_MAX_RESUME_BINDING_BYTES) || resumeKeys.has(binding.key)) {
        throw new Error('invalid computer task checkpoint resume context binding');
      }
      resumeKeys.add(binding.key);
    }
  }
  const seen = new Set<string>();
  for (const action of checkpoint.actions) {
    if (!boundedIdentifier(action?.stepId, 128) || !ACTION_STATES.includes(action.state) || seen.has(action.stepId)) {
      throw new Error('invalid computer task checkpoint action entry');
    }
    seen.add(action.stepId);
  }

  if (options.executionId !== undefined) {
    if (!EXECUTION_ID.test(options.executionId)) throw new Error('computer task execution id is invalid');
    if (checkpoint.execution.id !== options.executionId) throw new Error('computer task checkpoint belongs to another execution');
  }
  if (options.program) {
    const programErrors = validateComputerTaskProgram(options.program);
    if (programErrors.length > 0) throw new Error(`invalid computer task program: ${programErrors.join('; ')}`);
    if (checkpoint.program.id !== options.program.id || checkpoint.program.hash !== computerTaskProgramHash(options.program)) {
      throw new Error('computer task checkpoint does not match program');
    }
    const stepById = new Map(options.program.steps.map((step) => [step.id, step]));
    if (checkpoint.cursor.nextStepId !== undefined && !stepById.has(checkpoint.cursor.nextStepId)) {
      throw new Error('computer task checkpoint cursor names a missing step');
    }
    for (const action of checkpoint.actions) {
      if (stepById.get(action.stepId)?.kind !== 'action') {
        throw new Error('computer task checkpoint action names a missing or non-action step');
      }
    }
    const expectedActionIds = actionStepIds(options.program);
    const actualActionIds = [...seen].sort();
    if (expectedActionIds.length !== actualActionIds.length || expectedActionIds.some((id, index) => id !== actualActionIds[index])) {
      throw new Error('computer task checkpoint must include explicit state for every action step');
    }
    if (checkpoint.cursor.stepsExecuted === 0 && checkpoint.cursor.nextStepId !== options.program.entry) {
      throw new Error('computer task checkpoint zero-step cursor must remain at program entry');
    }
    const cursor = checkpoint.cursor.nextStepId ? stepById.get(checkpoint.cursor.nextStepId) : undefined;
    if (cursor?.kind === 'action') {
      const cursorState = checkpoint.actions.find((action) => action.stepId === cursor.id)?.state;
      if (!cursorState) throw new Error('computer task checkpoint cursor action is missing history state');
      if (cursorState === 'not-started' && !cursorReachableUnderHistory(options.program, checkpoint as ComputerTaskCheckpoint)) {
        throw new Error('computer task checkpoint cursor/action history is inconsistent');
      }
      if (cursorState === 'unknown-dispatch' || cursorState === 'dispatched-unverified') return;
    }
  }
}

export function createComputerTaskCheckpoint(options: {
  program: ComputerTaskProgram;
  executionId: string;
  nextStepId?: string;
  stepsExecuted: number;
  actions: ReadonlyMap<string, ComputerTaskActionCheckpointState> | Readonly<Record<string, ComputerTaskActionCheckpointState>>;
  resumeContext?: Readonly<Record<string, string>>;
}): ComputerTaskCheckpoint {
  const programErrors = validateComputerTaskProgram(options.program);
  if (programErrors.length > 0) throw new Error(`invalid computer task program: ${programErrors.join('; ')}`);
  const supplied = options.actions instanceof Map ? new Map(options.actions) : new Map(Object.entries(options.actions));
  const actions = actionStepIds(options.program).map((stepId) => ({
    stepId,
    state: supplied.get(stepId) ?? 'not-started',
  }));
  for (const suppliedStepId of supplied.keys()) {
    if (!actions.some((action) => action.stepId === suppliedStepId)) {
      throw new Error('computer task checkpoint action names a missing or non-action step');
    }
  }
  const resumeContext = options.resumeContext === undefined ? undefined : Object.entries(options.resumeContext)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value }));
  const checkpoint: ComputerTaskCheckpoint = {
    version: COMPUTER_TASK_CHECKPOINT_VERSION,
    program: { id: options.program.id, hash: computerTaskProgramHash(options.program) },
    execution: { id: options.executionId },
    cursor: { nextStepId: options.nextStepId, stepsExecuted: options.stepsExecuted },
    actions,
    ...(resumeContext ? { resumeContext } : {}),
  };
  validateComputerTaskCheckpoint(checkpoint, { program: options.program, executionId: options.executionId });
  return freezeCheckpoint(checkpoint);
}

export function encodeComputerTaskCheckpoint(checkpoint: ComputerTaskCheckpoint): string {
  validateComputerTaskCheckpoint(checkpoint);
  const payload = canonicalJson(checkpoint);
  const envelope: ComputerTaskCheckpointEnvelope = {
    format: COMPUTER_TASK_CHECKPOINT_FORMAT,
    integrity: { algorithm: 'sha256', digest: sha256(payload) },
    payload: checkpoint,
  };
  const encoded = canonicalJson(envelope);
  if (Buffer.byteLength(encoded, 'utf8') > COMPUTER_TASK_CHECKPOINT_MAX_BYTES) throw new Error('computer task checkpoint exceeds size limit');
  return encoded;
}

export function decodeComputerTaskCheckpoint(encoded: string): ComputerTaskCheckpoint {
  if (Buffer.byteLength(encoded, 'utf8') > COMPUTER_TASK_CHECKPOINT_MAX_BYTES) throw new Error('computer task checkpoint exceeds size limit');
  const envelope = JSON.parse(encoded) as Partial<ComputerTaskCheckpointEnvelope>;
  if (envelope.format !== COMPUTER_TASK_CHECKPOINT_FORMAT || envelope.integrity?.algorithm !== 'sha256' || !SHA256.test(envelope.integrity.digest)) {
    throw new Error('invalid computer task checkpoint envelope');
  }
  validateComputerTaskCheckpoint(envelope.payload);
  const expected = Buffer.from(sha256(canonicalJson(envelope.payload)), 'hex');
  const actual = Buffer.from(envelope.integrity.digest, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('computer task checkpoint integrity mismatch');
  return freezeCheckpoint(envelope.payload);
}
