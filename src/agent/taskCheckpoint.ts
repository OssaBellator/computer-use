import { createHash, timingSafeEqual } from 'node:crypto';
import { validateTaskProgram, type TaskProgram, type TaskStep } from './taskProgram.js';

export const TASK_CHECKPOINT_VERSION = 1 as const;
export const TASK_CHECKPOINT_FORMAT = 'browser-automation/task-checkpoint' as const;
export const TASK_CHECKPOINT_MAX_BYTES = 64 * 1024;
export const TASK_CHECKPOINT_MAX_VISIT_ENTRIES = 256;
export const TASK_CHECKPOINT_MAX_IDENTIFIER_BYTES = 128;
export const TASK_CHECKPOINT_MAX_BUDGET = 1_000_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const FINGERPRINT_HEX = /^[0-9a-f]{64}$/;
const EXECUTION_ID_HEX = /^[0-9a-f]{32,64}$/;

/** The exact task-program model is hashed; callers cannot pass an id-only projection by accident. */
export type CheckpointableTaskProgram = TaskProgram;

export interface TaskCheckpointProgramIdentity {
  id: string;
  hash: string;
}

export interface TaskCheckpointExecutionIdentity {
  /** Caller-generated non-sensitive 128-256 bit identity for one logical task execution. */
  id: string;
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
  /** Total task-program steps already started and completed before this checkpoint. */
  stepsExecuted: number;
  /** Visit counts for completed steps, sorted by step id when serialized. */
  visits: readonly TaskCheckpointVisitCounter[];
  consecutiveNoProgress: number;
}

export interface TaskCheckpoint {
  version: typeof TASK_CHECKPOINT_VERSION;
  program: TaskCheckpointProgramIdentity;
  execution: TaskCheckpointExecutionIdentity;
  cursor: TaskCheckpointCursor;
  budgets: TaskCheckpointBudgets;
  /** Opaque 256-bit lowercase-hex fingerprint derived from non-sensitive browser resume state. */
  browserStateFingerprint: string;
}

export interface CreateTaskCheckpointOptions {
  programId: string;
  /** Unique opaque identity for this logical execution; must not be derived from trusted input values. */
  executionId: string;
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
  | 'integrity-mismatch'
  | 'invalid-program'
  | 'invalid-state';

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
  | 'wrong-execution'
  | 'invalid-program'
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
  executionId: string;
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
  /** Program validation failures contain program metadata only, never trusted input values. */
  validationErrors?: string[];
  /** Ephemeral trusted values for the resumed runtime. Never serialize this object. */
  inputs?: Readonly<Record<string, string>>;
}

export interface PrepareTaskCheckpointResumeOptions extends TaskCheckpointCompatibilityOptions {
  trustedInputs: Readonly<Record<string, string>>;
}

export interface TaskCheckpointResumePreparation {
  ready: boolean;
  issues: TaskCheckpointCompatibilityIssue[];
  missingInputs: string[];
  /** Ephemeral trusted values exposed only after compatibility checks pass. Never serialize this object. */
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

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertIdentifier(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) codecError('invalid-schema', `${field} must be a non-empty string`);
  if (utf8Bytes(value) > TASK_CHECKPOINT_MAX_IDENTIFIER_BYTES) {
    codecError('invalid-schema', `${field} exceeds ${TASK_CHECKPOINT_MAX_IDENTIFIER_BYTES} UTF-8 bytes`);
  }
}

function assertExecutionId(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !EXECUTION_ID_HEX.test(value)) {
    codecError('invalid-schema', 'checkpoint execution id must be 32 to 64 lowercase hexadecimal characters');
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
  assertExactKeys(value, ['version', 'program', 'execution', 'cursor', 'budgets', 'browserStateFingerprint'], 'checkpoint payload');
  if (value.version !== TASK_CHECKPOINT_VERSION) {
    codecError('unsupported-version', `unsupported checkpoint version: ${String(value.version)}`);
  }

  if (!isPlainObject(value.program)) codecError('invalid-schema', 'checkpoint program identity must be an object');
  assertExactKeys(value.program, ['id', 'hash'], 'checkpoint program identity');
  assertIdentifier(value.program.id, 'checkpoint program id');
  if (typeof value.program.hash !== 'string' || !SHA256_HEX.test(value.program.hash)) {
    codecError('invalid-schema', 'checkpoint program hash must be a lowercase SHA-256 hex digest');
  }

  if (!isPlainObject(value.execution)) codecError('invalid-schema', 'checkpoint execution identity must be an object');
  assertExactKeys(value.execution, ['id'], 'checkpoint execution identity');
  assertExecutionId(value.execution.id);

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
    codecError('invalid-schema', 'checkpoint browserStateFingerprint must be a 64-character lowercase hex fingerprint');
  }
}

function normalizeCheckpoint(checkpoint: TaskCheckpoint): TaskCheckpoint {
  assertCheckpointSchema(checkpoint);
  return {
    version: TASK_CHECKPOINT_VERSION,
    program: { id: checkpoint.program.id, hash: checkpoint.program.hash },
    execution: { id: checkpoint.execution.id },
    cursor: {
      stepId: checkpoint.cursor.stepId,
      stepsExecuted: checkpoint.cursor.stepsExecuted,
      visits: checkpoint.cursor.visits
        .map(({ stepId, count }) => ({ stepId, count }))
        .sort((left, right) => compareCodeUnits(left.stepId, right.stepId)),
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

function safeProgramValidation(program: CheckpointableTaskProgram): ReturnType<typeof validateTaskProgram> {
  try { return validateTaskProgram(program); }
  catch { return { valid: false, errors: ['task program shape is invalid'], warnings: [] }; }
}

function assertValidTaskProgram(program: CheckpointableTaskProgram): void {
  const validation = safeProgramValidation(program);
  if (!validation.valid) codecError('invalid-program', `cannot checkpoint invalid task program: ${validation.errors.join('; ')}`);
}

function referencedStepIds(step: TaskStep): readonly string[] {
  switch (step.kind) {
    case 'activate': case 'hover': case 'type': case 'select-option': case 'upload': case 'press-key': case 'scroll-viewport': case 'switch-page': case 'navigate': case 'history': case 'handle-dialog': case 'open-tab': case 'close-latest-tab': case 'assert':
      return [step.next, ...(step.onFailure ? [step.onFailure] : [])];
    case 'branch': return [step.then, step.else];
    case 'wait': case 'wait-network-idle': return [step.next, ...(step.onTimeout ? [step.onTimeout] : [])];
    case 'fail': return [];
    case 'complete': return step.onFailure ? [step.onFailure] : [];
  }
}

/**
 * Necessary structural history check for a between-steps checkpoint. Every visited step and the
 * current cursor must be reachable from the entry by following edges through steps that have
 * actually been visited. This does not attempt to reconstruct branch predicate outcomes.
 */
function cursorHistoryIsStructurallyPossible(program: CheckpointableTaskProgram, checkpoint: TaskCheckpoint): boolean {
  if (checkpoint.cursor.stepsExecuted === 0) {
    return checkpoint.cursor.visits.length === 0 && checkpoint.cursor.stepId === program.entry;
  }

  const visited = new Set(checkpoint.cursor.visits.map((visit) => visit.stepId));
  const allowed = new Set(visited);
  allowed.add(checkpoint.cursor.stepId);
  const stepMap = new Map(program.steps.map((step) => [step.id, step] as const));
  const reachable = new Set<string>();
  const queue = [program.entry];

  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id) || !allowed.has(id)) continue;
    reachable.add(id);
    if (!visited.has(id)) continue;
    const step = stepMap.get(id);
    if (!step) continue;
    for (const next of referencedStepIds(step)) if (allowed.has(next)) queue.push(next);
  }

  if (!reachable.has(checkpoint.cursor.stepId)) return false;
  for (const id of visited) if (!reachable.has(id)) return false;
  return true;
}

function hashValidTaskProgram(program: CheckpointableTaskProgram): string {
  return sha256Hex(canonicalJson(program));
}

/** Deterministic SHA-256 over a canonical JSON representation of a valid complete task program. */
export function hashTaskProgram(program: CheckpointableTaskProgram): string {
  assertValidTaskProgram(program);
  return hashValidTaskProgram(program);
}

export function createTaskCheckpoint(options: CreateTaskCheckpointOptions): TaskCheckpoint {
  assertValidTaskProgram(options.program);
  const checkpoint = normalizeCheckpoint({
    version: TASK_CHECKPOINT_VERSION,
    program: {
      id: options.programId,
      hash: hashValidTaskProgram(options.program),
    },
    execution: { id: options.executionId },
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
  });
  const compatibility = checkTaskCheckpointCompatibility(checkpoint, {
    programId: options.programId,
    executionId: options.executionId,
    program: options.program,
    currentBrowserStateFingerprint: options.browserStateFingerprint,
  });
  if (!compatibility.compatible) {
    codecError('invalid-state', `cannot create non-resumable checkpoint: ${compatibility.issues.map((issue) => issue.code).join(', ')}`);
  }
  return checkpoint;
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

  const canonicalPayload = canonicalJson(parsed.payload);
  const expected = Buffer.from(sha256Hex(canonicalPayload), 'hex');
  const actual = Buffer.from(parsed.integrity.digest, 'hex');
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    codecError('integrity-mismatch', 'checkpoint integrity validation failed');
  }
  return normalizeCheckpoint(parsed.payload);
}

export function checkTaskCheckpointCompatibility(
  checkpoint: TaskCheckpoint,
  options: TaskCheckpointCompatibilityOptions,
): TaskCheckpointCompatibilityResult {
  assertCheckpointSchema(checkpoint);
  const issues: TaskCheckpointCompatibilityIssue[] = [];
  const programValidation = safeProgramValidation(options.program);
  if (!programValidation.valid) {
    issues.push({ code: 'invalid-program', message: 'current task program is invalid and cannot be resumed safely' });
  }

  if (checkpoint.program.id !== options.programId) {
    issues.push({ code: 'wrong-program', message: 'checkpoint program identity does not match the requested program' });
  } else if (programValidation.valid && checkpoint.program.hash !== hashValidTaskProgram(options.program)) {
    issues.push({ code: 'modified-program', message: 'checkpoint program hash does not match the current program definition' });
  }

  if (!EXECUTION_ID_HEX.test(options.executionId) || checkpoint.execution.id !== options.executionId) {
    issues.push({ code: 'wrong-execution', message: 'checkpoint execution identity does not match the logical task execution being resumed' });
  }

  const programStepIds = programValidation.valid
    ? new Set(options.program.steps.map((step) => step.id))
    : undefined;
  if (programStepIds && !programStepIds.has(checkpoint.cursor.stepId)) {
    issues.push({ code: 'impossible-step', message: 'checkpoint current step does not exist in the current program' });
  }

  const seenVisitSteps = new Set<string>();
  let visitTotal = 0;
  let countersMalformed = checkpoint.cursor.consecutiveNoProgress > checkpoint.cursor.stepsExecuted;
  let currentStepVisits = 0;
  for (const visit of checkpoint.cursor.visits) {
    if (seenVisitSteps.has(visit.stepId)) countersMalformed = true;
    seenVisitSteps.add(visit.stepId);
    visitTotal += visit.count;
    if (visit.count > checkpoint.budgets.maxVisitsPerStep) countersMalformed = true;
    if (visit.stepId === checkpoint.cursor.stepId) currentStepVisits = visit.count;
    if (programStepIds && !programStepIds.has(visit.stepId)) {
      issues.push({ code: 'impossible-step', message: `checkpoint visit counter references unknown step: ${visit.stepId}` });
    }
  }
  if (visitTotal !== checkpoint.cursor.stepsExecuted || checkpoint.cursor.stepsExecuted > checkpoint.budgets.maxSteps) {
    countersMalformed = true;
  }
  if (countersMalformed) {
    issues.push({ code: 'malformed-counters', message: 'checkpoint counters are inconsistent with execution state or configured budgets' });
  }

  if (programValidation.valid && programStepIds && [...seenVisitSteps].every((id) => programStepIds.has(id))) {
    if (!cursorHistoryIsStructurallyPossible(options.program, checkpoint)) {
      issues.push({ code: 'impossible-step', message: 'checkpoint cursor and visit history cannot arise from the current program graph' });
    }
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
 * Only own data properties matching inputs declared by the current valid program are copied;
 * accessors are not invoked.
 */
export function bindTrustedTaskResumeInputs(
  program: CheckpointableTaskProgram,
  trustedInputs: Readonly<Record<string, string>>,
): TaskResumeInputBindingResult {
  const validation = safeProgramValidation(program);
  if (!validation.valid) return { ok: false, missingInputs: [], validationErrors: [...validation.errors] };
  const declared = program.inputs ?? [];
  const missingInputs: string[] = [];
  const selected: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const name of declared) {
    let descriptor: PropertyDescriptor | undefined;
    try { descriptor = Object.getOwnPropertyDescriptor(trustedInputs, name); }
    catch { descriptor = undefined; }
    const value = descriptor && 'value' in descriptor ? descriptor.value : undefined;
    if (typeof value !== 'string') missingInputs.push(name);
    else selected[name] = value;
  }
  if (missingInputs.length) return { ok: false, missingInputs };
  return { ok: true, missingInputs: [], inputs: Object.freeze(selected) };
}

/**
 * Fail-closed resume preparation: compatibility (including execution identity and browser state)
 * is checked before trusted input properties are read or exposed to the caller.
 */
export function prepareTaskCheckpointResume(
  checkpoint: TaskCheckpoint,
  options: PrepareTaskCheckpointResumeOptions,
): TaskCheckpointResumePreparation {
  const compatibility = checkTaskCheckpointCompatibility(checkpoint, options);
  if (!compatibility.compatible) {
    return { ready: false, issues: compatibility.issues, missingInputs: [] };
  }
  const binding = bindTrustedTaskResumeInputs(options.program, options.trustedInputs);
  if (!binding.ok) {
    return { ready: false, issues: [], missingInputs: binding.missingInputs };
  }
  return { ready: true, issues: [], missingInputs: [], inputs: binding.inputs };
}
