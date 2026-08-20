import { createHash, timingSafeEqual } from 'node:crypto';

export const TASK_CHECKPOINT_VERSION = 1 as const;
export const TASK_CHECKPOINT_FORMAT = 'browser-automation/task-checkpoint' as const;
export const TASK_CHECKPOINT_MAX_BYTES = 64 * 1024;
export const TASK_CHECKPOINT_MAX_VISIT_ENTRIES = 256;
export const TASK_CHECKPOINT_MAX_IDENTIFIER_BYTES = 128;
export const TASK_CHECKPOINT_MAX_BUDGET = 1_000_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const FINGERPRINT_HEX = /^[0-9a-f]{8,128}$/;

export interface CheckpointableTaskProgram {
  version: number;
  name?: string;
  entry: string;
  inputs?: readonly string[];
  steps: readonly { id: string }[];
}

export interface TaskCheckpointProgramIdentity {
  id: string;
  hash: string;
}

export interface TaskCheckpointVisitCounter {
  stepId: string;
  count: number;
}

export interface TaskCheckpointBudgets {
  maxSteps: number;
  maxVisitsPerStep: number;
  maxConsecutiveNoProgress: number;
}

export interface TaskCheckpointCursor {
  /** The next task-program step that should execute after resume. */
  stepId: string;
  /** Total task-program steps already started before this checkpoint. */
  stepsExecuted: number;
  /** Visit counts for steps already started, sorted by step id when serialized. */
  visits: readonly TaskCheckpointVisitCounter[];
  consecutiveNoProgress: number;
}

export interface TaskCheckpoint {
  version: typeof TASK_CHECKPOINT_VERSION;
  program: TaskCheckpointProgramIdentity;
  cursor: TaskCheckpointCursor;
  budgets: TaskCheckpointBudgets;
  /** Opaque non-sensitive hash captured from the browser observation channel. */
  browserStateFingerprint: string;
}

export interface CreateTaskCheckpointOptions {
  programId: string;
  program: CheckpointableTaskProgram;
  currentStepId: string;
  stepsExecuted: number;
  visits: Readonly<Record<string, number>> | ReadonlyMap<string, number>;
  consecutiveNoProgress: number;
  budgets: TaskCheckpointBudgets;
  browserStateFingerprint: string;
}

export type TaskCheckpointCodecErrorCode =
  | 'payload-too-large'
  | 'malformed-json'
  | 'invalid-schema'
  | 'unsupported-version'
  | 'integrity-mismatch';

export class TaskCheckpointCodecError extends Error {
  constructor(
    public readonly code: TaskCheckpointCodecErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TaskCheckpointCodecError';
  }
}

export type TaskCheckpointCompatibilityIssueCode =
  | 'wrong-program'
  | 'modified-program'
  | 'impossible-step'
  | 'exhausted-budget'
  | 'malformed-counters'
  | 'browser-state-unverified'
  | 'browser-state-mismatch';

export interface TaskCheckpointCompatibilityIssue {
  code: TaskCheckpointCompatibilityIssueCode;
  message: string;
}

export interface TaskCheckpointCompatibilityOptions {
  programId: string;
  program: CheckpointableTaskProgram;
  currentBrowserStateFingerprint?: string;
}

export interface TaskCheckpointCompatibilityResult {
  compatible: boolean;
  issues: TaskCheckpointCompatibilityIssue[];
}

export interface TaskResumeInputBindingResult {
  ok: boolean;
  missingInputs: string[];
  /** Ephemeral trusted values for the resumed runtime. Never serialize this object. */
  inputs?: Readonly<Record<string, string>>;
}

interface SerializedCheckpointEnvelope {
  format: typeof TASK_CHECKPOINT_FORMAT;
  integrity: {
    algorithm: 'sha256';
    digest: string;
  };
  payload: TaskCheckpoint;
}

function codecError(code: TaskCheckpointCodecErrorCode, message: string): never {
  throw new TaskCheckpointCodecError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) codecError('invalid-schema', 'checkpoint data must contain only finite numbers');
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => {
      if (entry === undefined) codecError('invalid-schema', 'checkpoint arrays cannot contain undefined values');
      return canonicalJson(entry);
    }).join(',')}]`;
  }
  if (!isPlainObject(value)) codecError('invalid-schema', 'checkpoint data must contain only JSON objects');
  const members: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const entry = value[key];
    if (entry === undefined) continue;
    if (typeof entry === 'function' || typeof entry === 'symbol' || typeof entry === 'bigint') {
      codecError('invalid-schema', 'checkpoint data contains a non-JSON value');
    }
    members.push(`${JSON.stringify(key)}:${canonicalJson(entry)}`);
  }
  return `{${members.join(',')}}`;
}

function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) codecError('invalid-schema', `${field} must be a non-empty string`);
  if (utf8Bytes(value) > TASK_CHECKPOINT_MAX_IDENTIFIER_BYTES) {
    codecError('invalid-schema', `${field} exceeds ${TASK_CHECKPOINT_MAX_IDENTIFIER_BYTES} UTF-8 bytes`);
  }
}

function assertNonNegativeInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > TASK_CHECKPOINT_MAX_BUDGET) {
    codecError('invalid-schema', `${field} must be a non-negative integer no greater than ${TASK_CHECKPOINT_MAX_BUDGET}`);
  }
}

function assertPositiveBudget(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > TASK_CHECKPOINT_MAX_BUDGET) {
    codecError('invalid-schema', `${field} must be an integer from 1 to ${TASK_CHECKPOINT_MAX_BUDGET}`);
  }
}

function assertExactKeys(object: Record<string, unknown>, expected: readonly string[], field: string): void {
  const actual = Object.keys(object).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    codecError('invalid-schema', `${field} contains unsupported fields`);
  }
}

function assertCheckpointSchema(value: unknown): asserts value is TaskCheckpoint {
  if (!isPlainObject(value)) codecError('invalid-schema', 'checkpoint payload must be an object');
  assertExactKeys(value, ['version', 'program', 'cursor', 'budgets', 'browserStateFingerprint'], 'checkpoint payload');
  if (value.version !== TASK_CHECKPOINT_VERSION) {
    codecError('unsupported-version', `unsupported checkpoint version: ${String(value.version)}`);
  }

  if (!isPlainObject(value.program)) codecError('invalid-schema', 'checkpoint program identity must be an object');
  assertExactKeys(value.program, ['id', 'hash'], 'checkpoint program identity');
  assertIdentifier(value.program.id, 'checkpoint program id');
  if (typeof value.program.hash !== 'string' || !SHA256_HEX.test(value.program.hash)) {
    codecError('invalid-schema', 'checkpoint program hash must be a lowercase SHA-256 hex digest');
  }

  if (!isPlainObject(value.budgets)) codecError('invalid-schema', 'checkpoint budgets must be an object');
  assertExactKeys(value.budgets, ['maxSteps', 'maxVisitsPerStep', 'maxConsecutiveNoProgress'], 'checkpoint budgets');
  assertPositiveBudget(value.budgets.maxSteps, 'checkpoint maxSteps');
  assertPositiveBudget(value.budgets.maxVisitsPerStep, 'checkpoint maxVisitsPerStep');
  assertPositiveBudget(value.budgets.maxConsecutiveNoProgress, 'checkpoint maxConsecutiveNoProgress');

  if (!isPlainObject(value.cursor)) codecError('invalid-schema', 'checkpoint cursor must be an object');
  assertExactKeys(value.cursor, ['stepId', 'stepsExecuted', 'visits', 'consecutiveNoProgress'], 'checkpoint cursor');
  assertIdentifier(value.cursor.stepId, 'checkpoint current step id');
  assertNonNegativeInteger(value.cursor.stepsExecuted, 'checkpoint stepsExecuted');
  assertNonNegativeInteger(value.cursor.consecutiveNoProgress, 'checkpoint consecutiveNoProgress');
  if (!Array.isArray(value.cursor.visits)) codecError('invalid-schema', 'checkpoint visits must be an array');
  if (value.cursor.visits.length > TASK_CHECKPOINT_MAX_VISIT_ENTRIES) {
    codecError('invalid-schema', `checkpoint visits exceed ${TASK_CHECKPOINT_MAX_VISIT_ENTRIES} entries`);
  }
  for (let index = 0; index < value.cursor.visits.length; index += 1) {
    const visit = value.cursor.visits[index];
    if (!isPlainObject(visit)) codecError('invalid-schema', `checkpoint visit ${index} must be an object`);
    assertExactKeys(visit, ['stepId', 'count'], `checkpoint visit ${index}`);
    assertIdentifier(visit.stepId, `checkpoint visit ${index} stepId`);
    if (!Number.isSafeInteger(visit.count) || (visit.count as number) < 1 || (visit.count as number) > TASK_CHECKPOINT_MAX_BUDGET) {
      codecError('invalid-schema', `checkpoint visit ${index} count must be a positive bounded integer`);
    }
  }

  if (typeof value.browserStateFingerprint !== 'string' || !FINGERPRINT_HEX.test(value.browserStateFingerprint)) {
    codecError('invalid-schema', 'checkpoint browserStateFingerprint must be an opaque lowercase hex fingerprint');
  }
}

function normalizeCheckpoint(checkpoint: TaskCheckpoint): TaskCheckpoint {
  assertCheckpointSchema(checkpoint);
  return {
    version: TASK_CHECKPOINT_VERSION,
    program: { id: checkpoint.program.id, hash: checkpoint.program.hash },
    cursor: {
      stepId: checkpoint.cursor.stepId,
      stepsExecuted: checkpoint.cursor.stepsExecuted,
      visits: checkpoint.cursor.visits
        .map(({ stepId, count }) => ({ stepId, count }))
        .sort((left, right) => left.stepId.localeCompare(right.stepId)),
      consecutiveNoProgress: checkpoint.cursor.consecutiveNoProgress,
    },
    budgets: {
      maxSteps: checkpoint.budgets.maxSteps,
      maxVisitsPerStep: checkpoint.budgets.maxVisitsPerStep,
      maxConsecutiveNoProgress: checkpoint.budgets.maxConsecutiveNoProgress,
    },
    browserStateFingerprint: checkpoint.browserStateFingerprint,
  };
}

function visitEntries(visits: CreateTaskCheckpointOptions['visits']): TaskCheckpointVisitCounter[] {
  const entries = visits instanceof Map ? [...visits.entries()] : Object.entries(visits);
  return entries.map(([stepId, count]) => ({ stepId, count }));
}

/** Deterministic SHA-256 over a canonical JSON representation of the complete task program. */
export function hashTaskProgram(program: CheckpointableTaskProgram): string {
  return sha256Hex(canonicalJson(program));
}

export function createTaskCheckpoint(options: CreateTaskCheckpointOptions): TaskCheckpoint {
  const checkpoint: TaskCheckpoint = {
    version: TASK_CHECKPOINT_VERSION,
    program: {
      id: options.programId,
      hash: hashTaskProgram(options.program),
    },
    cursor: {
      stepId: options.currentStepId,
      stepsExecuted: options.stepsExecuted,
      visits: visitEntries(options.visits),
      consecutiveNoProgress: options.consecutiveNoProgress,
    },
    budgets: {
      maxSteps: options.budgets.maxSteps,
      maxVisitsPerStep: options.budgets.maxVisitsPerStep,
      maxConsecutiveNoProgress: options.budgets.maxConsecutiveNoProgress,
    },
    browserStateFingerprint: options.browserStateFingerprint,
  };
  return normalizeCheckpoint(checkpoint);
}

export function serializeTaskCheckpoint(checkpoint: TaskCheckpoint): string {
  const payload = normalizeCheckpoint(checkpoint);
  const payloadJson = canonicalJson(payload);
  const envelope: SerializedCheckpointEnvelope = {
    format: TASK_CHECKPOINT_FORMAT,
    integrity: { algorithm: 'sha256', digest: sha256Hex(payloadJson) },
    payload,
  };
  const encoded = canonicalJson(envelope);
  if (utf8Bytes(encoded) > TASK_CHECKPOINT_MAX_BYTES) {
    codecError('payload-too-large', `checkpoint exceeds ${TASK_CHECKPOINT_MAX_BYTES} UTF-8 bytes`);
  }
  return encoded;
}

export function deserializeTaskCheckpoint(encoded: string): TaskCheckpoint {
  if (typeof encoded !== 'string') codecError('malformed-json', 'checkpoint must be encoded as a string');
  if (utf8Bytes(encoded) > TASK_CHECKPOINT_MAX_BYTES) {
    codecError('payload-too-large', `checkpoint exceeds ${TASK_CHECKPOINT_MAX_BYTES} UTF-8 bytes`);
  }

  let parsed: unknown;
  try { parsed = JSON.parse(encoded); }
  catch { codecError('malformed-json', 'checkpoint is not valid JSON'); }
  if (!isPlainObject(parsed)) codecError('invalid-schema', 'checkpoint envelope must be an object');
  assertExactKeys(parsed, ['format', 'integrity', 'payload'], 'checkpoint envelope');
  if (parsed.format !== TASK_CHECKPOINT_FORMAT) codecError('invalid-schema', 'unsupported checkpoint format');
  if (!isPlainObject(parsed.payload)) codecError('invalid-schema', 'checkpoint payload must be an object');
  if (parsed.payload.version !== TASK_CHECKPOINT_VERSION) {
    codecError('unsupported-version', `unsupported checkpoint version: ${String(parsed.payload.version)}`);
  }
  assertCheckpointSchema(parsed.payload);

  if (!isPlainObject(parsed.integrity)) codecError('invalid-schema', 'checkpoint integrity block must be an object');
  assertExactKeys(parsed.integrity, ['algorithm', 'digest'], 'checkpoint integrity block');
  if (parsed.integrity.algorithm !== 'sha256' || typeof parsed.integrity.digest !== 'string' || !SHA256_HEX.test(parsed.integrity.digest)) {
    codecError('invalid-schema', 'checkpoint integrity block is invalid');
  }

  const payload = normalizeCheckpoint(parsed.payload);
  const expected = Buffer.from(sha256Hex(canonicalJson(payload)), 'hex');
  const actual = Buffer.from(parsed.integrity.digest, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    codecError('integrity-mismatch', 'checkpoint integrity validation failed');
  }
  return payload;
}

export function checkTaskCheckpointCompatibility(
  checkpoint: TaskCheckpoint,
  options: TaskCheckpointCompatibilityOptions,
): TaskCheckpointCompatibilityResult {
  assertCheckpointSchema(checkpoint);
  const issues: TaskCheckpointCompatibilityIssue[] = [];

  if (checkpoint.program.id !== options.programId) {
    issues.push({ code: 'wrong-program', message: 'checkpoint program identity does not match the requested program' });
  } else if (checkpoint.program.hash !== hashTaskProgram(options.program)) {
    issues.push({ code: 'modified-program', message: 'checkpoint program hash does not match the current program definition' });
  }

  const programStepIds = new Set(options.program.steps.map((step) => step.id));
  if (!programStepIds.has(checkpoint.cursor.stepId)) {
    issues.push({ code: 'impossible-step', message: 'checkpoint current step does not exist in the current program' });
  }

  const seenVisitSteps = new Set<string>();
  let visitTotal = 0;
  let countersMalformed = false;
  let currentStepVisits = 0;
  for (const visit of checkpoint.cursor.visits) {
    if (seenVisitSteps.has(visit.stepId)) countersMalformed = true;
    seenVisitSteps.add(visit.stepId);
    visitTotal += visit.count;
    if (visit.count > checkpoint.budgets.maxVisitsPerStep) countersMalformed = true;
    if (visit.stepId === checkpoint.cursor.stepId) currentStepVisits = visit.count;
    if (!programStepIds.has(visit.stepId)) {
      issues.push({ code: 'impossible-step', message: `checkpoint visit counter references unknown step: ${visit.stepId}` });
    }
  }
  if (visitTotal !== checkpoint.cursor.stepsExecuted || checkpoint.cursor.stepsExecuted > checkpoint.budgets.maxSteps) {
    countersMalformed = true;
  }
  if (countersMalformed) {
    issues.push({ code: 'malformed-counters', message: 'checkpoint visit counters are inconsistent with execution state or configured budgets' });
  }

  if (
    checkpoint.cursor.stepsExecuted >= checkpoint.budgets.maxSteps ||
    currentStepVisits >= checkpoint.budgets.maxVisitsPerStep ||
    checkpoint.cursor.consecutiveNoProgress >= checkpoint.budgets.maxConsecutiveNoProgress
  ) {
    issues.push({ code: 'exhausted-budget', message: 'checkpoint has no safe execution budget remaining for the current step' });
  }

  if (options.currentBrowserStateFingerprint === undefined) {
    issues.push({ code: 'browser-state-unverified', message: 'current browser state fingerprint is required before resume' });
  } else if (!FINGERPRINT_HEX.test(options.currentBrowserStateFingerprint) || options.currentBrowserStateFingerprint !== checkpoint.browserStateFingerprint) {
    issues.push({ code: 'browser-state-mismatch', message: 'current browser state does not match the checkpoint fingerprint' });
  }

  return { compatible: issues.length === 0, issues };
}

/**
 * Re-bind trusted input values after restart without ever persisting them in the checkpoint.
 * Only inputs declared by the current program are copied into the returned ephemeral object.
 */
export function bindTrustedTaskResumeInputs(
  program: CheckpointableTaskProgram,
  trustedInputs: Readonly<Record<string, string>>,
): TaskResumeInputBindingResult {
  const declared = program.inputs ?? [];
  const missingInputs: string[] = [];
  const selected: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of declared) {
    const value = trustedInputs[name];
    if (typeof value !== 'string') missingInputs.push(name);
    else selected[name] = value;
  }
  if (missingInputs.length) return { ok: false, missingInputs };
  return { ok: true, missingInputs: [], inputs: Object.freeze(selected) };
}
