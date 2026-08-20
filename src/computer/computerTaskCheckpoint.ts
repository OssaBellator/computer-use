import { createHash, timingSafeEqual } from 'node:crypto';
import { validateComputerTaskProgram, type ComputerTaskProgram } from './computerTask.js';

export const COMPUTER_TASK_CHECKPOINT_VERSION = 1 as const;
export const COMPUTER_TASK_CHECKPOINT_FORMAT = 'browser-automation/computer-task-checkpoint' as const;
export const COMPUTER_TASK_CHECKPOINT_MAX_BYTES = 64 * 1024;
export const COMPUTER_TASK_CHECKPOINT_MAX_STEPS_EXECUTED = 1_000_000;

export type ComputerTaskActionCheckpointState = 'not-started' | 'completed' | 'dispatched-unverified' | 'unknown-dispatch';
export type ComputerTaskCheckpointUncertainty = 'verification-pending' | 'verification-mismatch';

export interface ComputerTaskActionCheckpoint {
  stepId: string;
  state: ComputerTaskActionCheckpointState;
  /** Optional non-secret subtype for explicit post-restart reconciliation. */
  uncertainty?: ComputerTaskCheckpointUncertainty;
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
const UNCERTAINTIES: readonly ComputerTaskCheckpointUncertainty[] = ['verification-pending', 'verification-mismatch'];
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

function assertAllowedKeys(value: unknown, allowed: readonly string[], field: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`invalid ${field}`);
  const accepted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!accepted.has(key)) throw new Error(`${field} contains unsupported fields`);
  }
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
  const cursor = checkpoint.cursor.nextStepId === undefined
    ? { stepsExecuted: checkpoint.cursor.stepsExecuted }
    : { nextStepId: checkpoint.cursor.nextStepId, stepsExecuted: checkpoint.cursor.stepsExecuted };
  const frozen: ComputerTaskCheckpoint = {
    version: checkpoint.version,
    program: Object.freeze({ id: checkpoint.program.id, hash: checkpoint.program.hash }),
    execution: Object.freeze({ id: checkpoint.execution.id }),
    cursor: Object.freeze(cursor),
    actions: Object.freeze(checkpoint.actions.map((action) => Object.freeze(
      action.uncertainty === undefined
        ? { stepId: action.stepId, state: action.state }
        : { stepId: action.stepId, state: action.state, uncertainty: action.uncertainty },
    ))),
  };
  markCheckpointProvenance(frozen);
  return Object.freeze(frozen);
}

export function validateComputerTaskCheckpoint(
  value: unknown,
  options: ComputerTaskCheckpointValidationOptions = {},
): asserts value is ComputerTaskCheckpoint {
  assertAllowedKeys(value, ['version', 'program', 'execution', 'cursor', 'actions'], 'computer task checkpoint');
  const checkpoint = value as unknown as Partial<ComputerTaskCheckpoint>;
  if (options.requireRuntimeProvenance && (value as Partial<ProvenancedCheckpoint>)[CHECKPOINT_PROVENANCE] !== true) {
    throw new Error('computer task checkpoint lacks runtime provenance; use create/decode checkpoint APIs');
  }
  if (checkpoint.version !== COMPUTER_TASK_CHECKPOINT_VERSION) throw new Error('unsupported computer task checkpoint version');

  assertAllowedKeys(checkpoint.program, ['id', 'hash'], 'computer task checkpoint program identity');
  if (!boundedIdentifier(checkpoint.program.id, 128) || typeof checkpoint.program.hash !== 'string' || !SHA256.test(checkpoint.program.hash)) {
    throw new Error('invalid computer task checkpoint program identity');
  }

  assertAllowedKeys(checkpoint.execution, ['id'], 'computer task checkpoint execution identity');
  if (typeof checkpoint.execution.id !== 'string' || !EXECUTION_ID.test(checkpoint.execution.id)) {
    throw new Error('invalid computer task checkpoint execution identity');
  }

  assertAllowedKeys(checkpoint.cursor, ['nextStepId', 'stepsExecuted'], 'computer task checkpoint cursor');
  if (
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
  const seen = new Set<string>();
  for (const action of checkpoint.actions) {
    assertAllowedKeys(action, ['stepId', 'state', 'uncertainty'], 'computer task checkpoint action entry');
    if (!boundedIdentifier(action.stepId, 128) || !ACTION_STATES.includes(action.state) || seen.has(action.stepId)) {
      throw new Error('invalid computer task checkpoint action entry');
    }
    if (action.uncertainty !== undefined) {
      if (action.state !== 'dispatched-unverified' || !UNCERTAINTIES.includes(action.uncertainty)) {
        throw new Error('invalid computer task checkpoint uncertainty');
      }
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
  uncertainties?: ReadonlyMap<string, ComputerTaskCheckpointUncertainty> | Readonly<Record<string, ComputerTaskCheckpointUncertainty>>;
}): ComputerTaskCheckpoint {
  const programErrors = validateComputerTaskProgram(options.program);
  if (programErrors.length > 0) throw new Error(`invalid computer task program: ${programErrors.join('; ')}`);
  const supplied = options.actions instanceof Map ? new Map(options.actions) : new Map(Object.entries(options.actions));
  const suppliedUncertainties = options.uncertainties instanceof Map
    ? new Map(options.uncertainties)
    : new Map(Object.entries(options.uncertainties ?? {}));
  const actions = actionStepIds(options.program).map((stepId): ComputerTaskActionCheckpoint => {
    const state = supplied.get(stepId) ?? 'not-started';
    const uncertainty = suppliedUncertainties.get(stepId);
    return uncertainty === undefined ? { stepId, state } : { stepId, state, uncertainty };
  });
  for (const suppliedStepId of supplied.keys()) {
    if (!actions.some((action) => action.stepId === suppliedStepId)) {
      throw new Error('computer task checkpoint action names a missing or non-action step');
    }
  }
  for (const suppliedStepId of suppliedUncertainties.keys()) {
    if (!actions.some((action) => action.stepId === suppliedStepId)) {
      throw new Error('computer task checkpoint uncertainty names a missing or non-action step');
    }
  }
  const checkpoint: ComputerTaskCheckpoint = {
    version: COMPUTER_TASK_CHECKPOINT_VERSION,
    program: { id: options.program.id, hash: computerTaskProgramHash(options.program) },
    execution: { id: options.executionId },
    cursor: options.nextStepId === undefined
      ? { stepsExecuted: options.stepsExecuted }
      : { nextStepId: options.nextStepId, stepsExecuted: options.stepsExecuted },
    actions,
  };
  validateComputerTaskCheckpoint(checkpoint, { program: options.program, executionId: options.executionId });
  return freezeCheckpoint(checkpoint);
}

export function encodeComputerTaskCheckpoint(checkpoint: ComputerTaskCheckpoint): string {
  validateComputerTaskCheckpoint(checkpoint);
  const normalized = freezeCheckpoint(checkpoint);
  const payload = canonicalJson(normalized);
  const envelope: ComputerTaskCheckpointEnvelope = {
    format: COMPUTER_TASK_CHECKPOINT_FORMAT,
    integrity: { algorithm: 'sha256', digest: sha256(payload) },
    payload: normalized,
  };
  const encoded = canonicalJson(envelope);
  if (Buffer.byteLength(encoded, 'utf8') > COMPUTER_TASK_CHECKPOINT_MAX_BYTES) throw new Error('computer task checkpoint exceeds size limit');
  return encoded;
}

export function decodeComputerTaskCheckpoint(encoded: string): ComputerTaskCheckpoint {
  if (Buffer.byteLength(encoded, 'utf8') > COMPUTER_TASK_CHECKPOINT_MAX_BYTES) throw new Error('computer task checkpoint exceeds size limit');
  const parsed = JSON.parse(encoded) as unknown;
  assertAllowedKeys(parsed, ['format', 'integrity', 'payload'], 'computer task checkpoint envelope');
  const envelope = parsed as unknown as Partial<ComputerTaskCheckpointEnvelope>;
  assertAllowedKeys(envelope.integrity, ['algorithm', 'digest'], 'computer task checkpoint integrity');
  if (envelope.format !== COMPUTER_TASK_CHECKPOINT_FORMAT || envelope.integrity.algorithm !== 'sha256' || typeof envelope.integrity.digest !== 'string' || !SHA256.test(envelope.integrity.digest)) {
    throw new Error('invalid computer task checkpoint envelope');
  }
  validateComputerTaskCheckpoint(envelope.payload);
  const expected = Buffer.from(sha256(canonicalJson(envelope.payload)), 'hex');
  const actual = Buffer.from(envelope.integrity.digest, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('computer task checkpoint integrity mismatch');
  return freezeCheckpoint(envelope.payload);
}
