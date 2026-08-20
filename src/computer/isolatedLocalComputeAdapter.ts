import { createHash, randomBytes } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type {
  ComputerActionIdempotency,
  ComputerActionRequest,
  ComputerActionResult,
  ComputerDispatchState,
  ComputerEffectClass,
  ComputerEntityRef,
  ComputerEnvironmentAdapter,
  ComputerEnvironmentAdapterDescriptor,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from './environmentAdapter.js';
import {
  LOCAL_COMPUTE_CAPABILITY,
  localComputeJobEntity,
  type AllowedLocalComputeEffect,
  type LocalComputeArtifactIdentity,
  type LocalComputeExecutionState,
  type LocalComputeIdentity,
  type LocalComputeJson,
  type LocalComputeResourceLimits,
} from './localComputeAdapter.js';

/** A separate process with enforceable deadline/termination; this is not an OS security sandbox. */
export const ISOLATED_LOCAL_COMPUTE_EXECUTION_MODEL = 'isolated-child-process-enforceable-timeout' as const;

export interface IsolatedLocalComputeOperationDefinition {
  id: string;
  effect: AllowedLocalComputeEffect;
  /** Trusted host registration only. This value is never accepted from an action payload. */
  moduleUrl: string;
  /** Named module export containing a function or { execute() }. */
  exportName: string;
}

export interface IsolatedLocalComputeJobRequest {
  job: LocalComputeIdentity;
  operation: string;
  input: LocalComputeJson;
  limits?: Partial<LocalComputeResourceLimits>;
  expectedInputArtifactId?: string;
}

export interface IsolatedLocalComputeJobSnapshot {
  identity: LocalComputeIdentity;
  operation: string;
  effect: AllowedLocalComputeEffect;
  inputArtifact: LocalComputeArtifactIdentity;
  outputArtifact?: LocalComputeArtifactIdentity;
  executionState: LocalComputeExecutionState;
  dispatch: ComputerDispatchState;
  diagnostics: readonly string[];
}

export interface IsolatedLocalComputeAdapterOptions {
  id?: string;
  operations: readonly IsolatedLocalComputeOperationDefinition[];
  maxRetainedJobs?: number;
  /** Non-evicted exactly-once ledger capacity. Once full, new identities fail closed. */
  maxLedgerEntries?: number;
  maxArtifactStoreBytes?: number;
  /** Cleanup acknowledgement bound after the execution deadline has already expired. */
  terminationAcknowledgeMs?: number;
  /** Test/fault-injection seam: seals dispatch as uncertain without making the job replayable. */
  ambiguousLaunchOperationIds?: readonly string[];
}

const DEFAULT_LIMITS: LocalComputeResourceLimits = Object.freeze({
  timeBudgetMs: 5_000,
  maxInputBytes: 256 * 1024,
  maxOutputBytes: 256 * 1024,
  maxDiagnosticBytes: 4 * 1024,
  maxJsonDepth: 64,
  maxJsonItems: 100_000,
  memoryBytesHint: 64 * 1024 * 1024,
});
const MAX_LIMITS: LocalComputeResourceLimits = Object.freeze({
  timeBudgetMs: 60_000,
  maxInputBytes: 4 * 1024 * 1024,
  maxOutputBytes: 4 * 1024 * 1024,
  maxDiagnosticBytes: 64 * 1024,
  maxJsonDepth: 128,
  maxJsonItems: 1_000_000,
  memoryBytesHint: 2 * 1024 * 1024 * 1024,
});
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const EXPORT_NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const DEFAULT_MAX_RETAINED_JOBS = 256;
const DEFAULT_MAX_LEDGER_ENTRIES = 4_096;
const DEFAULT_MAX_ARTIFACT_STORE_BYTES = 16 * 1024 * 1024;
const MAX_RETENTION_COUNT = 100_000;
const MAX_ARTIFACT_STORE_BYTES = 512 * 1024 * 1024;
const DEFAULT_TERMINATION_ACK_MS = 1_000;
const MAX_TERMINATION_ACK_MS = 10_000;

interface CanonicalizedJson { encoded: string; byteLength: number; shape: string }
interface StoredArtifact { encoded: string; identity: LocalComputeArtifactIdentity }
interface LedgerEntry { dispatch: ComputerDispatchState; executionState: LocalComputeExecutionState }
interface WorkerResultMessage { type: 'result'; token: string; outputEncoded: string; outputHash: string; byteLength: number; shape: string; diagnostics?: unknown }
interface WorkerErrorMessage { type: 'error'; token: string; code: string; diagnostics?: unknown }
type WorkerOutcome =
  | { kind: 'result'; message: WorkerResultMessage }
  | { kind: 'worker-error'; message: WorkerErrorMessage }
  | { kind: 'crash'; code: number | null; signal: NodeJS.Signals | null }
  | { kind: 'launch-uncertain'; reason: string }
  | { kind: 'timed-out'; terminationConfirmed: boolean };

function bytes(value: string): number { return Buffer.byteLength(value, 'utf8'); }
function sha256(value: string): string { return `sha256-${createHash('sha256').update(value, 'utf8').digest('hex')}`; }
function identityKey(identity: LocalComputeIdentity): string { return `${identity.jobId}:${identity.generation}`; }
function artifactKey(identity: LocalComputeArtifactIdentity): string { return `${identity.artifactId}:${identity.generation}`; }

function canonicalizeJson(value: unknown, maxBytes: number, maxDepth: number, maxItems: number): CanonicalizedJson {
  let itemCount = 0;
  let byteLength = 0;
  let rootShape = 'unknown';
  const chunks: string[] = [];
  const append = (chunk: string): void => {
    byteLength += bytes(chunk);
    if (byteLength > maxBytes) throw new Error('json-byte-limit');
    chunks.push(chunk);
  };
  const visit = (current: unknown, depth: number): void => {
    if (depth > maxDepth) throw new Error('json-depth-limit');
    itemCount += 1;
    if (itemCount > maxItems) throw new Error('json-item-limit');
    if (current === null) { if (depth === 0) rootShape = 'null'; append('null'); return; }
    if (typeof current === 'string' || typeof current === 'boolean') { if (depth === 0) rootShape = typeof current; append(JSON.stringify(current)); return; }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('non-finite-number');
      if (depth === 0) rootShape = 'number';
      append(Object.is(current, -0) ? '0' : JSON.stringify(current));
      return;
    }
    if (Array.isArray(current)) {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === 'length') continue;
        if (!/^(0|[1-9][0-9]*)$/.test(key) || descriptor.get || descriptor.set) throw new Error('invalid-array-property');
      }
      if (depth === 0) rootShape = `array:${current.length}`;
      append('[');
      for (let index = 0; index < current.length; index += 1) {
        if (index > 0) append(',');
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) throw new Error('sparse-array');
        visit(descriptor.value, depth + 1);
      }
      append(']');
      return;
    }
    if (typeof current === 'object') {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('non-plain-object');
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Object.keys(descriptors).sort();
      if (depth === 0) rootShape = `object:${keys.length}`;
      append('{');
      keys.forEach((key, index) => {
        if (FORBIDDEN_KEYS.has(key)) throw new Error('unsafe-object-key');
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || descriptor.get || descriptor.set || !('value' in descriptor)) throw new Error('invalid-object-property');
        if (index > 0) append(',');
        append(JSON.stringify(key)); append(':'); visit(descriptor.value, depth + 1);
      });
      append('}');
      return;
    }
    throw new Error('unsupported-json-type');
  };
  visit(value, 0);
  return { encoded: chunks.join(''), byteLength, shape: rootShape };
}

function immutableJson(encoded: string): LocalComputeJson {
  const value = JSON.parse(encoded) as LocalComputeJson;
  const freeze = (current: LocalComputeJson): LocalComputeJson => {
    if (current && typeof current === 'object') {
      if (Array.isArray(current)) for (const item of current) freeze(item);
      else for (const item of Object.values(current)) freeze(item);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(value);
}

function artifactFromCanonical(canonical: CanonicalizedJson, generation: number): LocalComputeArtifactIdentity {
  const contentHash = sha256(canonical.encoded);
  return Object.freeze({ artifactId: `artifact:${contentHash}`, generation, contentHash, byteLength: canonical.byteLength, shape: canonical.shape, state: 'committed' as const });
}

function resolveLimits(input: Partial<LocalComputeResourceLimits> | undefined): LocalComputeResourceLimits | null {
  if (input === null || (input !== undefined && (typeof input !== 'object' || Array.isArray(input)))) return null;
  const allowed = new Set(['timeBudgetMs', 'maxInputBytes', 'maxOutputBytes', 'maxDiagnosticBytes', 'maxJsonDepth', 'maxJsonItems', 'memoryBytesHint']);
  if (input && Object.keys(input).some((key) => !allowed.has(key))) return null;
  const result = { ...DEFAULT_LIMITS, ...(input ?? {}) };
  for (const key of ['timeBudgetMs', 'maxInputBytes', 'maxOutputBytes', 'maxDiagnosticBytes', 'maxJsonDepth', 'maxJsonItems'] as const) {
    const value = result[key];
    if (!Number.isSafeInteger(value) || value < 1 || value > MAX_LIMITS[key]) return null;
  }
  if (result.memoryBytesHint !== undefined && (!Number.isSafeInteger(result.memoryBytesHint) || result.memoryBytesHint < 1 || result.memoryBytesHint > MAX_LIMITS.memoryBytesHint!)) return null;
  return Object.freeze(result);
}

function expectedRequestSemantics(effect: AllowedLocalComputeEffect): { effect: ComputerEffectClass; idempotency: ComputerActionIdempotency } {
  return effect === 'pure-read-only' ? { effect: 'observe-only', idempotency: 'read-only' } : { effect: 'local-reversible', idempotency: 'non-idempotent' };
}

function boundedPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) throw new Error('invalid isolated local compute limit');
  return resolved;
}

function freezeSnapshot(snapshot: IsolatedLocalComputeJobSnapshot): IsolatedLocalComputeJobSnapshot {
  return Object.freeze({ ...snapshot, identity: Object.freeze({ ...snapshot.identity }), inputArtifact: Object.freeze({ ...snapshot.inputArtifact }), outputArtifact: snapshot.outputArtifact ? Object.freeze({ ...snapshot.outputArtifact }) : undefined, diagnostics: Object.freeze([...snapshot.diagnostics]) });
}

/**
 * Process-isolated local compute backend.
 *
 * Guarantees: registered-operation-only dispatch, bounded serialized input/output,
 * wall-clock execution deadline spanning process launch through output verification,
 * and forced child termination after deadline with confirmation before claiming it.
 * The dispatch ledger is never evicted; capacity exhaustion fails closed.
 *
 * Non-guarantees: this is not a filesystem/network/security sandbox. Registered modules
 * remain trusted host authority. `memoryBytesHint` is only a resource hint: this adapter
 * does not claim or enforce a strict total-memory limit for the child process.
 */
export class IsolatedLocalComputeAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor;
  private readonly operations = new Map<string, Readonly<IsolatedLocalComputeOperationDefinition>>();
  private readonly ambiguousLaunch: Set<string>;
  private readonly jobs = new Map<string, IsolatedLocalComputeJobSnapshot>();
  private readonly ledger = new Map<string, LedgerEntry>();
  private readonly highestGeneration = new Map<string, number>();
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly maxRetainedJobs: number;
  private readonly maxLedgerEntries: number;
  private readonly maxArtifactStoreBytes: number;
  private readonly terminationAcknowledgeMs: number;
  private artifactStoreBytes = 0;
  private sequence = 0;

  constructor(options: IsolatedLocalComputeAdapterOptions) {
    const id = options.id ?? 'isolated-local-compute';
    if (!ID.test(id)) throw new Error('invalid isolated local compute adapter id');
    for (const operation of options.operations) {
      if (!ID.test(operation.id) || !EXPORT_NAME.test(operation.exportName) || typeof operation.moduleUrl !== 'string' || operation.moduleUrl.length === 0 || operation.moduleUrl.length > 4096) throw new Error(`invalid isolated local compute operation: ${operation.id}`);
      if (operation.effect !== 'pure-read-only' && operation.effect !== 'local-artifact-creation') throw new Error(`unsafe isolated local compute operation effect: ${operation.effect}`);
      if (this.operations.has(operation.id)) throw new Error(`duplicate isolated local compute operation: ${operation.id}`);
      this.operations.set(operation.id, Object.freeze({ id: operation.id, effect: operation.effect, moduleUrl: operation.moduleUrl, exportName: operation.exportName }));
    }
    this.ambiguousLaunch = new Set(options.ambiguousLaunchOperationIds ?? []);
    for (const id of this.ambiguousLaunch) if (!this.operations.has(id)) throw new Error(`ambiguous launch operation is not registered: ${id}`);
    this.maxRetainedJobs = boundedPositiveInteger(options.maxRetainedJobs, DEFAULT_MAX_RETAINED_JOBS, MAX_RETENTION_COUNT);
    this.maxLedgerEntries = boundedPositiveInteger(options.maxLedgerEntries, DEFAULT_MAX_LEDGER_ENTRIES, MAX_RETENTION_COUNT);
    this.maxArtifactStoreBytes = boundedPositiveInteger(options.maxArtifactStoreBytes, DEFAULT_MAX_ARTIFACT_STORE_BYTES, MAX_ARTIFACT_STORE_BYTES);
    this.terminationAcknowledgeMs = boundedPositiveInteger(options.terminationAcknowledgeMs, DEFAULT_TERMINATION_ACK_MS, MAX_TERMINATION_ACK_MS);
    this.descriptor = Object.freeze({ id, kind: 'local-compute', version: '1-isolated', capabilities: Object.freeze([LOCAL_COMPUTE_CAPABILITY]) });
  }

  artifactContent(ref: LocalComputeArtifactIdentity): LocalComputeJson | undefined {
    const stored = this.artifacts.get(artifactKey(ref));
    if (!stored) return undefined;
    const actual = stored.identity;
    if (actual.contentHash !== ref.contentHash || actual.byteLength !== ref.byteLength || actual.generation !== ref.generation || actual.shape !== ref.shape || actual.state !== ref.state) return undefined;
    try {
      const parsed = JSON.parse(stored.encoded) as LocalComputeJson;
      const canonical = canonicalizeJson(parsed, actual.byteLength, MAX_LIMITS.maxJsonDepth, MAX_LIMITS.maxJsonItems);
      if (canonical.encoded !== stored.encoded || canonical.byteLength !== actual.byteLength || canonical.shape !== actual.shape || sha256(canonical.encoded) !== actual.contentHash) return undefined;
      return immutableJson(canonical.encoded);
    } catch { return undefined; }
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    if (request.adapterId !== this.descriptor.id || request.channel !== 'compute') throw new Error('unsupported isolated local compute observation');
    let snapshot: IsolatedLocalComputeJobSnapshot | undefined;
    if (request.target) {
      if (request.target.environment !== 'local-compute' || request.target.kind !== 'compute-job' || request.target.adapterId !== this.descriptor.id) throw new Error('invalid isolated compute job target');
      snapshot = this.jobs.get(`${request.target.entityId}:${request.target.generation ?? 0}`);
    }
    return { adapterId: this.descriptor.id, environment: 'local-compute', channel: 'compute', sequence: this.sequence++, complete: true, truncated: false, target: request.target, data: snapshot ?? null };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    if (request.adapterId !== this.descriptor.id || request.capability !== LOCAL_COMPUTE_CAPABILITY) return this.reject('compute-isolated-capability-rejected');
    const payload = this.parsePayload(request.payload);
    if (!payload) return this.reject('compute-isolated-request-invalid');
    if (request.target && !this.targetMatchesJob(request.target, payload.job)) return this.reject('compute-isolated-target-mismatch');
    const operation = this.operations.get(payload.operation);
    if (!operation) return this.reject('compute-isolated-operation-unregistered', 'unsupported');
    const expected = expectedRequestSemantics(operation.effect);
    if (request.effect !== expected.effect || request.idempotency !== expected.idempotency) return this.reject('compute-isolated-effect-mismatch');
    const limits = resolveLimits(payload.limits);
    if (!limits) return this.reject('compute-isolated-limits-invalid');

    let inputCanonical: CanonicalizedJson;
    try { inputCanonical = canonicalizeJson(payload.input, limits.maxInputBytes, limits.maxJsonDepth, limits.maxJsonItems); }
    catch (error) { return this.reject(error instanceof Error && error.message === 'json-byte-limit' ? 'compute-isolated-input-limit' : 'compute-isolated-input-invalid'); }
    const inputArtifact = artifactFromCanonical(inputCanonical, payload.job.generation);
    if (payload.expectedInputArtifactId !== undefined && payload.expectedInputArtifactId !== inputArtifact.artifactId) return this.reject('compute-isolated-input-artifact-mismatch');

    const key = identityKey(payload.job);
    const prior = this.ledger.get(key);
    if (prior) {
      const known = this.jobs.get(key);
      return known ? this.resultForKnown(known) : this.resultForEvictedLedger(prior);
    }
    const highest = this.highestGeneration.get(payload.job.jobId);
    if (highest !== undefined && payload.job.generation < highest) return this.reject('compute-isolated-job-stale');
    if (this.ledger.size >= this.maxLedgerEntries) return this.reject('compute-isolated-ledger-full');

    // Seal the identity before process launch. From here onward uncertainty never permits replay.
    this.ledger.set(key, { dispatch: 'unknown', executionState: 'accepted' });
    this.highestGeneration.set(payload.job.jobId, Math.max(highest ?? payload.job.generation, payload.job.generation));
    let snapshot = freezeSnapshot({ identity: payload.job, operation: operation.id, effect: operation.effect, inputArtifact, executionState: 'accepted', dispatch: 'unknown', diagnostics: [] });
    this.setJob(key, snapshot);

    if (this.ambiguousLaunch.has(operation.id)) {
      snapshot = freezeSnapshot({ ...snapshot, executionState: 'unknown', dispatch: 'unknown', diagnostics: ['compute-isolated-launch-ambiguous'] });
      this.updateLedger(key, snapshot);
      this.setJob(key, snapshot);
      return { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: ['compute-isolated-launch-ambiguous'], details: { job: snapshot } };
    }

    const deadlineEpochMs = Date.now() + limits.timeBudgetMs;
    const outcome = await this.runIsolated(operation, inputCanonical.encoded, payload.job, limits, deadlineEpochMs, (dispatch) => {
      snapshot = freezeSnapshot({ ...snapshot, executionState: dispatch === 'dispatched-once' ? 'running' : 'unknown', dispatch });
      this.updateLedger(key, snapshot);
      this.setJob(key, snapshot);
    });

    if (outcome.kind === 'timed-out') {
      snapshot = freezeSnapshot({ ...snapshot, executionState: outcome.terminationConfirmed ? 'timed-out' : 'unknown', dispatch: outcome.terminationConfirmed && snapshot.dispatch === 'dispatched-once' ? 'dispatched-once' : 'unknown', diagnostics: [...snapshot.diagnostics, outcome.terminationConfirmed ? 'compute-isolated-worker-terminated' : 'compute-isolated-termination-uncertain'] });
      this.updateLedger(key, snapshot); this.setJob(key, snapshot);
      return { status: outcome.terminationConfirmed ? 'failed' : 'unknown', dispatch: snapshot.dispatch, verification: outcome.terminationConfirmed ? 'rejected' : 'unverified', evidence: [outcome.terminationConfirmed ? 'compute-isolated-timeout-terminated' : 'compute-isolated-termination-uncertain'], details: { job: snapshot } };
    }
    if (outcome.kind === 'launch-uncertain') {
      snapshot = freezeSnapshot({ ...snapshot, executionState: 'unknown', dispatch: 'unknown', diagnostics: ['compute-isolated-launch-uncertain'] });
      this.updateLedger(key, snapshot); this.setJob(key, snapshot);
      return { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: ['compute-isolated-launch-uncertain'], details: { job: snapshot } };
    }
    if (outcome.kind === 'crash') {
      snapshot = freezeSnapshot({ ...snapshot, executionState: 'failed', dispatch: snapshot.dispatch === 'dispatched-once' ? 'dispatched-once' : 'unknown', diagnostics: ['compute-isolated-worker-crashed'] });
      this.updateLedger(key, snapshot); this.setJob(key, snapshot);
      return { status: 'failed', dispatch: snapshot.dispatch, verification: 'rejected', evidence: ['compute-isolated-worker-crashed'], details: { job: snapshot, exitCode: outcome.code, signal: outcome.signal } };
    }
    const diagnostics = this.validDiagnostics(outcome.message.diagnostics, limits.maxDiagnosticBytes);
    if (outcome.kind === 'worker-error') {
      const limited = outcome.message.code === 'output-limit';
      snapshot = freezeSnapshot({ ...snapshot, executionState: limited ? 'output-limited' : 'failed', dispatch: 'dispatched-once', diagnostics });
      this.updateLedger(key, snapshot); this.setJob(key, snapshot);
      return { status: 'failed', dispatch: 'dispatched-once', verification: 'rejected', evidence: [limited ? 'compute-isolated-output-limit' : 'compute-isolated-execution-failed'], details: { job: snapshot } };
    }

    let outputCanonical: CanonicalizedJson;
    try {
      if (bytes(outcome.message.outputEncoded) > limits.maxOutputBytes) throw new Error('json-byte-limit');
      const parsed = JSON.parse(outcome.message.outputEncoded) as LocalComputeJson;
      outputCanonical = canonicalizeJson(parsed, limits.maxOutputBytes, limits.maxJsonDepth, limits.maxJsonItems);
      if (outputCanonical.encoded !== outcome.message.outputEncoded || outputCanonical.byteLength !== outcome.message.byteLength || outputCanonical.shape !== outcome.message.shape || sha256(outputCanonical.encoded) !== outcome.message.outputHash) throw new Error('verification-mismatch');
    } catch (error) {
      const limited = error instanceof Error && error.message === 'json-byte-limit';
      snapshot = freezeSnapshot({ ...snapshot, executionState: limited ? 'output-limited' : 'failed', dispatch: 'dispatched-once', diagnostics });
      this.updateLedger(key, snapshot); this.setJob(key, snapshot);
      return { status: 'failed', dispatch: 'dispatched-once', verification: 'rejected', evidence: [limited ? 'compute-isolated-output-limit' : 'compute-isolated-output-verification-failed'], details: { job: snapshot } };
    }
    if (Date.now() > deadlineEpochMs) {
      // Result missed the advertised deadline; never accept it as successful.
      snapshot = freezeSnapshot({ ...snapshot, executionState: 'timed-out', dispatch: 'dispatched-once', diagnostics: [...diagnostics, 'compute-isolated-late-result-rejected'] });
      this.updateLedger(key, snapshot); this.setJob(key, snapshot);
      return { status: 'failed', dispatch: 'dispatched-once', verification: 'rejected', evidence: ['compute-isolated-timeout-terminated'], details: { job: snapshot } };
    }

    const outputArtifact = artifactFromCanonical(outputCanonical, payload.job.generation);
    snapshot = freezeSnapshot({ ...snapshot, outputArtifact, executionState: 'completed', dispatch: 'dispatched-once', diagnostics });
    this.updateLedger(key, snapshot); this.setJob(key, snapshot);
    const output = immutableJson(outputCanonical.encoded);
    if (operation.effect === 'local-artifact-creation') {
      this.storeArtifact(outputCanonical, outputArtifact);
      return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified', evidence: ['compute-isolated-artifact-verified'], details: { job: snapshot, artifact: outputArtifact } };
    }
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified', evidence: ['compute-isolated-output-verified'], details: { job: snapshot, output } };
  }

  private runIsolated(operation: Readonly<IsolatedLocalComputeOperationDefinition>, inputEncoded: string, job: LocalComputeIdentity, limits: LocalComputeResourceLimits, deadlineEpochMs: number, onDispatch: (dispatch: ComputerDispatchState) => void): Promise<WorkerOutcome> {
    return new Promise((resolve) => {
      let child: ChildProcess;
      let settled = false;
      let spawned = false;
      const token = randomBytes(16).toString('hex');
      const workerPath = fileURLToPath(new URL('./isolatedLocalComputeWorker.js', import.meta.url));
      const finish = (outcome: WorkerOutcome): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadlineTimer);
        clearTimeout(terminationTimer);
        child?.removeAllListeners();
        if (child?.connected) child.disconnect();
        resolve(outcome);
      };
      let deadlineTimer: NodeJS.Timeout | undefined;
      let terminationTimer: NodeJS.Timeout | undefined;
      try {
        child = fork(workerPath, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json' });
      } catch {
        resolve({ kind: 'launch-uncertain', reason: 'fork-threw' });
        return;
      }
      const terminateForDeadline = (): void => {
        if (settled) return;
        let killAccepted = false;
        try { killAccepted = child.kill('SIGKILL'); } catch { killAccepted = false; }
        if (!killAccepted && child.exitCode === null && child.signalCode === null) {
          finish({ kind: 'timed-out', terminationConfirmed: false });
          return;
        }
        terminationTimer = setTimeout(() => finish({ kind: 'timed-out', terminationConfirmed: child.exitCode !== null || child.signalCode !== null }), this.terminationAcknowledgeMs);
      };
      const remaining = Math.max(0, deadlineEpochMs - Date.now());
      deadlineTimer = setTimeout(terminateForDeadline, remaining);
      child.once('spawn', () => { spawned = true; onDispatch('dispatched-once'); });
      child.once('error', () => finish({ kind: 'launch-uncertain', reason: spawned ? 'child-error-after-spawn' : 'child-error-before-spawn' }));
      child.on('message', (raw: unknown) => {
        if (settled || Date.now() > deadlineEpochMs || !raw || typeof raw !== 'object') return;
        const message = raw as Partial<WorkerResultMessage & WorkerErrorMessage>;
        if (message.token !== token) return;
        if (message.type === 'result' && typeof message.outputEncoded === 'string' && typeof message.outputHash === 'string' && typeof message.byteLength === 'number' && typeof message.shape === 'string') finish({ kind: 'result', message: message as WorkerResultMessage });
        else if (message.type === 'error' && typeof message.code === 'string') finish({ kind: 'worker-error', message: message as WorkerErrorMessage });
      });
      child.once('exit', (code, signal) => {
        if (settled) return;
        if (Date.now() >= deadlineEpochMs) finish({ kind: 'timed-out', terminationConfirmed: true });
        else finish({ kind: 'crash', code, signal });
      });
      child.send({ type: 'run', token, operationId: operation.id, moduleUrl: operation.moduleUrl, exportName: operation.exportName, inputEncoded, deadlineEpochMs, limits: { maxOutputBytes: limits.maxOutputBytes, maxDiagnosticBytes: limits.maxDiagnosticBytes, maxJsonDepth: limits.maxJsonDepth, maxJsonItems: limits.maxJsonItems, memoryBytesHint: limits.memoryBytesHint }, job }, (error) => { if (error && !settled) finish({ kind: 'launch-uncertain', reason: 'ipc-send-uncertain' }); });
    });
  }

  private parsePayload(payload: unknown): IsolatedLocalComputeJobRequest | null {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
    const descriptors = Object.getOwnPropertyDescriptors(payload);
    const allowed = new Set(['job', 'operation', 'input', 'limits', 'expectedInputArtifactId']);
    if (Object.keys(descriptors).some((key) => !allowed.has(key))) return null;
    for (const descriptor of Object.values(descriptors)) if (descriptor.get || descriptor.set || !('value' in descriptor)) return null;
    const value = payload as Partial<IsolatedLocalComputeJobRequest>;
    if (!value.job || typeof value.job !== 'object' || Array.isArray(value.job) || !ID.test(value.job.jobId) || !Number.isSafeInteger(value.job.generation) || value.job.generation < 0 || !ID.test(value.operation ?? '')) return null;
    if (value.expectedInputArtifactId !== undefined && typeof value.expectedInputArtifactId !== 'string') return null;
    return { job: { jobId: value.job.jobId, generation: value.job.generation }, operation: value.operation!, input: value.input as LocalComputeJson, limits: value.limits, expectedInputArtifactId: value.expectedInputArtifactId };
  }

  private targetMatchesJob(target: ComputerEntityRef, identity: LocalComputeIdentity): boolean {
    return target.environment === 'local-compute' && target.kind === 'compute-job' && target.adapterId === this.descriptor.id && target.entityId === identity.jobId && (target.generation ?? 0) === identity.generation;
  }

  private validDiagnostics(raw: unknown, maxBytes: number): string[] {
    if (!Array.isArray(raw)) return [];
    const result: string[] = [];
    let used = 0;
    for (const item of raw) {
      if (typeof item !== 'string' || !/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(item)) continue;
      const size = bytes(item);
      if (used + size > maxBytes) break;
      used += size; result.push(item);
    }
    return result;
  }

  private updateLedger(key: string, snapshot: IsolatedLocalComputeJobSnapshot): void { this.ledger.set(key, { dispatch: snapshot.dispatch, executionState: snapshot.executionState }); }
  private setJob(key: string, snapshot: IsolatedLocalComputeJobSnapshot): void {
    if (!this.jobs.has(key) && this.jobs.size >= this.maxRetainedJobs) this.jobs.delete(this.jobs.keys().next().value as string);
    this.jobs.set(key, snapshot);
  }
  private storeArtifact(canonical: CanonicalizedJson, identity: LocalComputeArtifactIdentity): void {
    if (canonical.byteLength > this.maxArtifactStoreBytes) return;
    while (this.artifacts.size && this.artifactStoreBytes + canonical.byteLength > this.maxArtifactStoreBytes) {
      const oldest = this.artifacts.keys().next().value as string;
      const prior = this.artifacts.get(oldest)!;
      this.artifactStoreBytes -= prior.identity.byteLength;
      this.artifacts.delete(oldest);
    }
    const key = artifactKey(identity);
    const prior = this.artifacts.get(key);
    if (prior) this.artifactStoreBytes -= prior.identity.byteLength;
    this.artifacts.set(key, { encoded: canonical.encoded, identity });
    this.artifactStoreBytes += canonical.byteLength;
  }

  private resultForKnown(snapshot: IsolatedLocalComputeJobSnapshot): ComputerActionResult {
    if (snapshot.executionState === 'completed') return { status: 'completed', dispatch: snapshot.dispatch, verification: 'verified', evidence: ['compute-isolated-known-completed'], details: { job: snapshot } };
    if (snapshot.executionState === 'unknown') return { status: 'unknown', dispatch: snapshot.dispatch, verification: 'unverified', evidence: ['compute-isolated-known-uncertain'], details: { job: snapshot } };
    return { status: 'failed', dispatch: snapshot.dispatch, verification: 'rejected', evidence: ['compute-isolated-known-failed'], details: { job: snapshot } };
  }
  private resultForEvictedLedger(entry: LedgerEntry): ComputerActionResult {
    if (entry.executionState === 'unknown' || entry.dispatch === 'unknown') return { status: 'unknown', dispatch: entry.dispatch, verification: 'unverified', evidence: ['compute-isolated-job-state-evicted'] };
    return { status: entry.executionState === 'completed' ? 'completed' : 'failed', dispatch: entry.dispatch, verification: 'unverified', evidence: ['compute-isolated-job-state-evicted'] };
  }
  private reject(evidence: string, status: ComputerActionResult['status'] = 'rejected'): ComputerActionResult { return { status, dispatch: 'not-dispatched', verification: 'rejected', evidence: [evidence] }; }
}

export function isolatedLocalComputeJobEntity(adapterId: string, identity: LocalComputeIdentity): ComputerEntityRef {
  return localComputeJobEntity(adapterId, identity);
}
