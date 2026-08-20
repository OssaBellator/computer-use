import { createHash, timingSafeEqual } from 'node:crypto';
import { validateComputerTaskProgram, type ComputerTaskProgram } from './computerTask.js';

export const COMPUTER_TASK_CHECKPOINT_VERSION = 1 as const;
export const COMPUTER_TASK_CHECKPOINT_FORMAT = 'browser-automation/computer-task-checkpoint' as const;
export const COMPUTER_TASK_CHECKPOINT_MAX_BYTES = 64 * 1024;
export const COMPUTER_TASK_CHECKPOINT_MAX_STEPS_EXECUTED = 1_000_000;

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
}

export interface ComputerTaskCheckpointValidationOptions {
  program?: ComputerTaskProgram;
  executionId?: string;
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

export function validateComputerTaskCheckpoint(
  value: unknown,
  options: ComputerTaskCheckpointValidationOptions = {},
): asserts value is ComputerTaskCheckpoint {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid computer task checkpoint');
  const checkpoint = value as Partial<ComputerTaskCheckpoint>;
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
  }
}

export function createComputerTaskCheckpoint(options: {
  program: ComputerTaskProgram;
  executionId: string;
  nextStepId?: string;
  stepsExecuted: number;
  actions: ReadonlyMap<string, ComputerTaskActionCheckpointState> | Readonly<Record<string, ComputerTaskActionCheckpointState>>;
}): ComputerTaskCheckpoint {
  const programErrors = validateComputerTaskProgram(options.program);
  if (programErrors.length > 0) throw new Error(`invalid computer task program: ${programErrors.join('; ')}`);
  const entries = options.actions instanceof Map ? [...options.actions.entries()] : Object.entries(options.actions);
  const actions = entries.map(([stepId, state]) => ({ stepId, state })).sort((a, b) => a.stepId < b.stepId ? -1 : a.stepId > b.stepId ? 1 : 0);
  const checkpoint: ComputerTaskCheckpoint = {
    version: COMPUTER_TASK_CHECKPOINT_VERSION,
    program: { id: options.program.id, hash: computerTaskProgramHash(options.program) },
    execution: { id: options.executionId },
    cursor: { nextStepId: options.nextStepId, stepsExecuted: options.stepsExecuted },
    actions,
  };
  validateComputerTaskCheckpoint(checkpoint, { program: options.program, executionId: options.executionId });
  return Object.freeze({
    version: checkpoint.version,
    program: Object.freeze({ ...checkpoint.program }),
    execution: Object.freeze({ ...checkpoint.execution }),
    cursor: Object.freeze({ ...checkpoint.cursor }),
    actions: Object.freeze(checkpoint.actions.map((action) => Object.freeze({ ...action }))),
  });
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
  return Object.freeze({
    version: COMPUTER_TASK_CHECKPOINT_VERSION,
    program: Object.freeze({ ...envelope.payload.program }),
    execution: Object.freeze({ ...envelope.payload.execution }),
    cursor: Object.freeze({ ...envelope.payload.cursor }),
    actions: Object.freeze(envelope.payload.actions.map((entry) => Object.freeze({ ...entry }))),
  });
}
