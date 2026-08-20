import { createHash } from 'node:crypto';
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

export const LOCAL_COMPUTE_CAPABILITY = 'local-compute.run';
export const LOCAL_COMPUTE_EXECUTION_MODEL = 'trusted-in-process-cooperative' as const;
export const LOCAL_COMPUTE_EFFECTS = [
  'pure-read-only',
  'local-artifact-creation',
  'process-execution',
  'external-network',
  'system-modification',
] as const;

export type LocalComputeEffect = typeof LOCAL_COMPUTE_EFFECTS[number];
export type AllowedLocalComputeEffect = Extract<LocalComputeEffect, 'pure-read-only' | 'local-artifact-creation'>;
export type LocalComputeExecutionState =
  | 'accepted'
  | 'running'
  | 'completed'
  | 'failed'
  | 'timed-out'
  | 'output-limited'
  | 'unknown';
export type LocalComputeJson = null | boolean | number | string | LocalComputeJson[] | { [key: string]: LocalComputeJson };

export interface LocalComputeIdentity { jobId: string; generation: number }
export interface LocalComputeArtifactIdentity {
  artifactId: string;
  generation: number;
  contentHash: string;
  byteLength: number;
  shape: string;
  state: 'committed';
}
export interface LocalComputeResourceLimits {
  /** Cooperative deadline only; registered in-process operations are trusted to honor cancellation. */
  timeBudgetMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
  maxDiagnosticBytes: number;
  maxJsonDepth: number;
  maxJsonItems: number;
  memoryBytesHint?: number;
}
export interface LocalComputeOperationContext {
  readonly signal: AbortSignal;
  readonly limits: Readonly<LocalComputeResourceLimits>;
  diagnostic(code: string): void;
}
export interface LocalComputeOperationDefinition<I extends LocalComputeJson = LocalComputeJson, O extends LocalComputeJson = LocalComputeJson> {
  id: string;
  effect: LocalComputeEffect;
  execute(input: I, context: LocalComputeOperationContext): O | Promise<O>;
}
export interface LocalComputeJobRequest {
  job: LocalComputeIdentity;
  operation: string;
  input: LocalComputeJson;
  limits?: Partial<LocalComputeResourceLimits>;
  expectedInputArtifactId?: string;
}
export interface LocalComputeJobSnapshot {
  identity: LocalComputeIdentity;
  operation: string;
  effect: AllowedLocalComputeEffect;
  inputArtifact: LocalComputeArtifactIdentity;
  outputArtifact?: LocalComputeArtifactIdentity;
  executionState: LocalComputeExecutionState;
  dispatch: ComputerDispatchState;
  diagnostics: readonly string[];
}
export interface LocalComputeAdapterOptions {
  id?: string;
  operations: readonly LocalComputeOperationDefinition[];
  ambiguousDispatchOperationIds?: readonly string[];
  maxRetainedJobs?: number;
  /** Bounded fail-closed execution-ledger capacity. Entries are never evicted during adapter lifetime. */
  maxRetainedJobIds?: number;
  maxArtifactStoreBytes?: number;
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
const DEFAULT_MAX_RETAINED_JOBS = 256;
const DEFAULT_MAX_RETAINED_JOB_IDS = 256;
const DEFAULT_MAX_ARTIFACT_STORE_BYTES = 16 * 1024 * 1024;
const MAX_RETENTION_COUNT = 100_000;
const MAX_ARTIFACT_STORE_BYTES = 512 * 1024 * 1024;
const ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const DIAGNOSTIC = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const ARTIFACT_ID = /^artifact:sha256-[a-f0-9]{64}$/;
const FORBIDDEN_OBJECT_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

interface CanonicalizedJson { encoded: string; byteLength: number; shape: string }
interface StoredArtifact { encoded: string; identity: LocalComputeArtifactIdentity }
interface ExecutionLedgerEntry { generation: number; dispatch: ComputerDispatchState; executionState: LocalComputeExecutionState }

function bytes(value: string): number { return Buffer.byteLength(value, 'utf8'); }
function sha256(value: string): string { return `sha256-${createHash('sha256').update(value, 'utf8').digest('hex')}`; }

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
    if (current === null) {
      if (depth === 0) rootShape = 'null';
      append('null');
      return;
    }
    if (typeof current === 'string' || typeof current === 'boolean') {
      if (depth === 0) rootShape = typeof current;
      append(JSON.stringify(current));
      return;
    }
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
        if (!/^(0|[1-9][0-9]*)$/.test(key) || descriptor.get !== undefined || descriptor.set !== undefined) {
          throw new Error('invalid-array-property');
        }
      }
      if (depth === 0) rootShape = `array:${current.length}`;
      append('[');
      for (let index = 0; index < current.length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) throw new Error('sparse-array');
        if (index > 0) append(',');
        visit(descriptor.value, depth + 1);
      }
      append(']');
      return;
    }
    if (typeof current !== 'object') throw new Error('non-json-value');
    const prototype = Object.getPrototypeOf(current);
    if (prototype !== Object.prototype && prototype !== null) throw new Error('non-plain-object');
    const descriptors = Object.getOwnPropertyDescriptors(current);
    const keys = Object.keys(descriptors).filter((key) => descriptors[key]!.enumerable).sort();
    if (depth === 0) rootShape = `object:${keys.length}`;
    append('{');
    for (let index = 0; index < keys.length; index += 1) {
      const key = keys[index]!;
      const descriptor = descriptors[key]!;
      if (FORBIDDEN_OBJECT_KEYS.has(key)) throw new Error('unsafe-object-key');
      if (!('value' in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) throw new Error('accessor-property');
      if (index > 0) append(',');
      append(JSON.stringify(key));
      append(':');
      visit(descriptor.value, depth + 1);
    }
    append('}');
  };
  visit(value, 0);
  return { encoded: chunks.join(''), byteLength, shape: rootShape };
}

function immutableJsonFromCanonical(canonical: CanonicalizedJson): LocalComputeJson {
  const value = JSON.parse(canonical.encoded) as LocalComputeJson;
  const freeze = (current: LocalComputeJson): void => {
    if (current === null || typeof current !== 'object') return;
    if (Array.isArray(current)) for (const item of current) freeze(item);
    else for (const item of Object.values(current)) freeze(item);
    Object.freeze(current);
  };
  freeze(value);
  return value;
}

function artifactFromCanonical(canonical: CanonicalizedJson, generation = 0): LocalComputeArtifactIdentity {
  const contentHash = sha256(canonical.encoded);
  return Object.freeze({
    artifactId: `artifact:${contentHash}`,
    generation,
    contentHash,
    byteLength: canonical.byteLength,
    shape: canonical.shape,
    state: 'committed',
  });
}

function validIdentity(job: LocalComputeIdentity): boolean {
  return ID.test(job.jobId) && Number.isSafeInteger(job.generation) && job.generation >= 0;
}
function resolveLimits(partial: Partial<LocalComputeResourceLimits> | undefined): LocalComputeResourceLimits | null {
  const result = { ...DEFAULT_LIMITS, ...partial };
  for (const key of ['timeBudgetMs', 'maxInputBytes', 'maxOutputBytes', 'maxDiagnosticBytes', 'maxJsonDepth', 'maxJsonItems'] as const) {
    const n = result[key];
    if (!Number.isSafeInteger(n) || n < 1 || n > MAX_LIMITS[key]) return null;
  }
  if (result.memoryBytesHint !== undefined &&
    (!Number.isSafeInteger(result.memoryBytesHint) || result.memoryBytesHint < 1 || result.memoryBytesHint > MAX_LIMITS.memoryBytesHint!)) return null;
  return result;
}
function expectedRequestSemantics(effect: AllowedLocalComputeEffect): { effect: ComputerEffectClass; idempotency: ComputerActionIdempotency } {
  return effect === 'pure-read-only'
    ? { effect: 'observe-only', idempotency: 'read-only' }
    : { effect: 'local-reversible', idempotency: 'non-idempotent' };
}
function freezeSnapshot(snapshot: LocalComputeJobSnapshot): LocalComputeJobSnapshot {
  return Object.freeze({
    ...snapshot,
    identity: Object.freeze({ ...snapshot.identity }),
    inputArtifact: Object.freeze({ ...snapshot.inputArtifact }),
    outputArtifact: snapshot.outputArtifact ? Object.freeze({ ...snapshot.outputArtifact }) : undefined,
    diagnostics: Object.freeze([...snapshot.diagnostics]),
  });
}
function boundedPositiveInteger(value: number | undefined, fallback: number, max: number): number {
  const resolved = value ?? fallback;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > max) throw new Error('invalid local compute retention limit');
  return resolved;
}

/**
 * Trusted in-process cooperative compute backend. Registered operations are snapshotted
 * authority, but they are not resource-isolated: AbortSignal is cooperative and a
 * blocking callback can monopolize the event loop. A worker/isolate backend is required
 * before claiming hard CPU/time/memory termination guarantees.
 */
export class LocalComputeAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor;
  private readonly operations = new Map<string, LocalComputeOperationDefinition>();
  private readonly ambiguous: Set<string>;
  private readonly jobs = new Map<string, LocalComputeJobSnapshot>();
  private readonly executionLedger = new Map<string, ExecutionLedgerEntry>();
  private readonly artifacts = new Map<string, StoredArtifact>();
  private readonly maxRetainedJobs: number;
  private readonly maxRetainedJobIds: number;
  private readonly maxArtifactStoreBytes: number;
  private artifactStoreBytes = 0;
  private sequence = 0;

  constructor(options: LocalComputeAdapterOptions) {
    const id = options.id ?? 'local-compute';
    if (!ID.test(id)) throw new Error('invalid local compute adapter id');
    for (const operation of options.operations) {
      if (!ID.test(operation.id)) throw new Error(`invalid local compute operation id: ${operation.id}`);
      if (operation.effect !== 'pure-read-only' && operation.effect !== 'local-artifact-creation') {
        throw new Error(`unsafe local compute operation effect: ${operation.effect}`);
      }
      if (this.operations.has(operation.id)) throw new Error(`duplicate local compute operation: ${operation.id}`);
      this.operations.set(operation.id, Object.freeze({ id: operation.id, effect: operation.effect, execute: operation.execute }) as LocalComputeOperationDefinition);
    }
    this.ambiguous = new Set(options.ambiguousDispatchOperationIds ?? []);
    for (const operationId of this.ambiguous) {
      if (!this.operations.has(operationId)) throw new Error(`ambiguous operation is not registered: ${operationId}`);
    }
    this.maxRetainedJobs = boundedPositiveInteger(options.maxRetainedJobs, DEFAULT_MAX_RETAINED_JOBS, MAX_RETENTION_COUNT);
    this.maxRetainedJobIds = boundedPositiveInteger(options.maxRetainedJobIds, DEFAULT_MAX_RETAINED_JOB_IDS, MAX_RETENTION_COUNT);
    this.maxArtifactStoreBytes = boundedPositiveInteger(options.maxArtifactStoreBytes, DEFAULT_MAX_ARTIFACT_STORE_BYTES, MAX_ARTIFACT_STORE_BYTES);
    this.descriptor = Object.freeze({ id, kind: 'local-compute', version: '1', capabilities: Object.freeze([LOCAL_COMPUTE_CAPABILITY]) });
  }

  artifactContent(ref: LocalComputeArtifactIdentity): LocalComputeJson | undefined {
    const stored = this.artifacts.get(ref.artifactId);
    if (!stored) return undefined;
    const actual = stored.identity;
    if (actual.contentHash !== ref.contentHash || actual.byteLength !== ref.byteLength || actual.generation !== ref.generation || actual.state !== ref.state) return undefined;
    const parsed = JSON.parse(stored.encoded) as LocalComputeJson;
    const canonical = canonicalizeJson(parsed, actual.byteLength, MAX_LIMITS.maxJsonDepth, MAX_LIMITS.maxJsonItems);
    if (canonical.byteLength !== actual.byteLength || sha256(canonical.encoded) !== actual.contentHash) return undefined;
    return immutableJsonFromCanonical(canonical);
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    if (request.adapterId !== this.descriptor.id || request.channel !== 'compute') throw new Error('unsupported local compute observation');
    let snapshot: LocalComputeJobSnapshot | undefined;
    if (request.target) {
      if (request.target.environment !== 'local-compute' || request.target.kind !== 'compute-job' || request.target.adapterId !== this.descriptor.id) {
        throw new Error('invalid compute job target');
      }
      snapshot = this.jobs.get(`${request.target.entityId}:${request.target.generation ?? 0}`);
    }
    return {
      adapterId: this.descriptor.id,
      environment: 'local-compute',
      channel: 'compute',
      sequence: this.sequence++,
      complete: true,
      truncated: false,
      target: request.target,
      data: snapshot ?? null,
    };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    if (request.adapterId !== this.descriptor.id || request.capability !== LOCAL_COMPUTE_CAPABILITY) return this.reject('compute-capability-rejected');
    const payload = this.parsePayload(request.payload);
    if (!payload) return this.reject('compute-request-invalid');
    if (request.target && !this.targetMatchesJob(request.target, payload.job)) return this.reject('compute-target-mismatch');

    const operation = this.operations.get(payload.operation);
    if (!operation) return this.reject('compute-operation-unregistered', 'unsupported');
    const expected = expectedRequestSemantics(operation.effect as AllowedLocalComputeEffect);
    if (request.effect !== expected.effect || request.idempotency !== expected.idempotency) return this.reject('compute-effect-mismatch');

    const limits = resolveLimits(payload.limits);
    if (!limits) return this.reject('compute-limits-invalid');
    let inputCanonical: CanonicalizedJson;
    try {
      inputCanonical = canonicalizeJson(payload.input, limits.maxInputBytes, limits.maxJsonDepth, limits.maxJsonItems);
    } catch (error) {
      return this.reject(error instanceof Error && error.message === 'json-byte-limit' ? 'compute-input-limit' : 'compute-input-invalid');
    }
    const inputArtifact = artifactFromCanonical(inputCanonical);
    const executionInput = immutableJsonFromCanonical(inputCanonical);
    if (payload.expectedInputArtifactId !== undefined && payload.expectedInputArtifactId !== inputArtifact.artifactId) {
      return this.reject('compute-input-artifact-mismatch');
    }

    const ledger = this.executionLedger.get(payload.job.jobId);
    if (ledger) {
      if (payload.job.generation < ledger.generation) return this.reject('compute-job-stale');
      if (payload.job.generation === ledger.generation) {
        const known = this.jobs.get(`${payload.job.jobId}:${payload.job.generation}`);
        return known ? this.resultForKnown(known) : this.resultForEvictedLedger(ledger);
      }
    } else if (this.executionLedger.size >= this.maxRetainedJobIds) {
      return this.reject('compute-execution-ledger-full');
    }

    const key = `${payload.job.jobId}:${payload.job.generation}`;
    this.executionLedger.set(payload.job.jobId, { generation: payload.job.generation, dispatch: 'not-dispatched', executionState: 'accepted' });
    let snapshot = freezeSnapshot({
      identity: payload.job,
      operation: operation.id,
      effect: operation.effect as AllowedLocalComputeEffect,
      inputArtifact,
      executionState: 'accepted' as const,
      dispatch: 'not-dispatched' as const,
      diagnostics: [],
    });
    this.setJob(key, snapshot);

    if (this.ambiguous.has(operation.id)) {
      snapshot = freezeSnapshot({ ...snapshot, executionState: 'unknown', dispatch: 'unknown', diagnostics: ['compute-dispatch-ambiguous'] });
      this.updateLedger(snapshot);
      this.setJob(key, snapshot);
      return { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: ['compute-dispatch-ambiguous'], details: { job: snapshot } };
    }

    const diagnostics: string[] = [];
    let diagnosticBytes = 0;
    const controller = new AbortController();
    const context: LocalComputeOperationContext = {
      signal: controller.signal,
      limits: Object.freeze({ ...limits }),
      diagnostic: (code) => {
        if (!DIAGNOSTIC.test(code)) return;
        const extra = bytes(code) + (diagnostics.length ? 1 : 0);
        if (diagnosticBytes + extra > limits.maxDiagnosticBytes) return;
        diagnostics.push(code);
        diagnosticBytes += extra;
      },
    };
    snapshot = freezeSnapshot({ ...snapshot, executionState: 'running', dispatch: 'dispatched-once' });
    this.updateLedger(snapshot);
    this.setJob(key, snapshot);

    const startedAt = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timedOut = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort('cooperative-time-budget-exceeded');
          reject(new Error('cooperative-timeout'));
        }, limits.timeBudgetMs);
      });
      const execution = Promise.resolve().then(() => operation.execute(executionInput, context));
      execution.catch(() => undefined);
      const output = await Promise.race([execution, timedOut]);
      if (performance.now() - startedAt > limits.timeBudgetMs) {
        controller.abort('cooperative-time-budget-exceeded');
        throw new Error('cooperative-timeout');
      }

      let outputCanonical: CanonicalizedJson;
      try {
        outputCanonical = canonicalizeJson(output, limits.maxOutputBytes, limits.maxJsonDepth, limits.maxJsonItems);
      } catch (error) {
        if (error instanceof Error && error.message === 'json-byte-limit') {
          snapshot = freezeSnapshot({ ...snapshot, executionState: 'output-limited', diagnostics });
          this.updateLedger(snapshot);
          this.setJob(key, snapshot);
          return { status: 'failed', dispatch: 'dispatched-once', verification: 'rejected', evidence: ['compute-output-limit'], details: { job: snapshot } };
        }
        throw new Error('invalid-output');
      }

      const outputArtifact = artifactFromCanonical(outputCanonical);
      const immutableOutput = immutableJsonFromCanonical(outputCanonical);
      if (operation.effect === 'local-artifact-creation' && !this.storeArtifact(outputArtifact, outputCanonical)) {
        snapshot = freezeSnapshot({ ...snapshot, executionState: 'output-limited', diagnostics });
        this.updateLedger(snapshot);
        this.setJob(key, snapshot);
        return { status: 'failed', dispatch: 'dispatched-once', verification: 'rejected', evidence: ['compute-artifact-store-limit'], details: { job: snapshot } };
      }

      snapshot = freezeSnapshot({ ...snapshot, outputArtifact, executionState: 'completed', diagnostics });
      this.updateLedger(snapshot);
      this.setJob(key, snapshot);
      return {
        status: 'completed',
        dispatch: 'dispatched-once',
        verification: 'verified',
        evidence: [operation.effect === 'pure-read-only' ? 'compute-output-verified' : 'compute-artifact-verified'],
        details: operation.effect === 'pure-read-only' ? { job: snapshot, output: immutableOutput } : { job: snapshot, artifact: outputArtifact },
      };
    } catch (error) {
      const timeout = controller.signal.aborted || (error instanceof Error && error.message === 'cooperative-timeout');
      snapshot = freezeSnapshot({ ...snapshot, executionState: timeout ? 'timed-out' : 'failed', diagnostics });
      this.updateLedger(snapshot);
      this.setJob(key, snapshot);
      return {
        status: 'failed',
        dispatch: 'dispatched-once',
        verification: 'rejected',
        evidence: [timeout ? 'compute-cooperative-timeout' : 'compute-execution-failed'],
        details: { job: snapshot },
      };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private parsePayload(value: unknown): LocalComputeJobRequest | null {
    if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const allowed = new Set(['job', 'operation', 'input', 'limits', 'expectedInputArtifactId']);
    if (Object.keys(descriptors).some((key) => !allowed.has(key))) return null;
    if (Object.values(descriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) return null;
    const record = Object.fromEntries(Object.entries(descriptors).filter(([, descriptor]) => descriptor.enumerable).map(([key, descriptor]) => [key, descriptor.value])) as Record<string, unknown>;
    if (typeof record.operation !== 'string' || !ID.test(record.operation)) return null;

    if (record.job === null || typeof record.job !== 'object' || Array.isArray(record.job) || Object.getPrototypeOf(record.job) !== Object.prototype) return null;
    const jobDescriptors = Object.getOwnPropertyDescriptors(record.job);
    if (Object.keys(jobDescriptors).some((key) => key !== 'jobId' && key !== 'generation')) return null;
    if (Object.values(jobDescriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) return null;
    const job = Object.fromEntries(Object.entries(jobDescriptors).filter(([, descriptor]) => descriptor.enumerable).map(([key, descriptor]) => [key, descriptor.value])) as Record<string, unknown>;
    if (typeof job.jobId !== 'string' || typeof job.generation !== 'number' || !validIdentity(job as unknown as LocalComputeIdentity)) return null;

    if (record.expectedInputArtifactId !== undefined && (typeof record.expectedInputArtifactId !== 'string' || !ARTIFACT_ID.test(record.expectedInputArtifactId))) return null;

    let limits: Partial<LocalComputeResourceLimits> | undefined;
    if (record.limits !== undefined) {
      if (record.limits === null || typeof record.limits !== 'object' || Array.isArray(record.limits) || Object.getPrototypeOf(record.limits) !== Object.prototype) return null;
      const limitDescriptors = Object.getOwnPropertyDescriptors(record.limits);
      const allowedLimits = new Set(['timeBudgetMs', 'maxInputBytes', 'maxOutputBytes', 'maxDiagnosticBytes', 'maxJsonDepth', 'maxJsonItems', 'memoryBytesHint']);
      if (Object.keys(limitDescriptors).some((key) => !allowedLimits.has(key))) return null;
      if (Object.values(limitDescriptors).some((descriptor) => descriptor.get !== undefined || descriptor.set !== undefined)) return null;
      limits = Object.fromEntries(Object.entries(limitDescriptors).filter(([, descriptor]) => descriptor.enumerable).map(([key, descriptor]) => [key, descriptor.value])) as Partial<LocalComputeResourceLimits>;
    }

    return {
      job: job as unknown as LocalComputeIdentity,
      operation: record.operation,
      input: record.input as LocalComputeJson,
      limits,
      expectedInputArtifactId: record.expectedInputArtifactId as string | undefined,
    };
  }

  private targetMatchesJob(target: ComputerEntityRef, job: LocalComputeIdentity): boolean {
    return target.adapterId === this.descriptor.id &&
      target.environment === 'local-compute' &&
      target.kind === 'compute-job' &&
      target.entityId === job.jobId &&
      target.generation === job.generation &&
      target.surfaceId === undefined;
  }

  private updateLedger(snapshot: LocalComputeJobSnapshot): void {
    const current = this.executionLedger.get(snapshot.identity.jobId);
    if (current && current.generation > snapshot.identity.generation) return;
    this.executionLedger.set(snapshot.identity.jobId, {
      generation: snapshot.identity.generation,
      dispatch: snapshot.dispatch,
      executionState: snapshot.executionState,
    });
  }

  private setJob(key: string, snapshot: LocalComputeJobSnapshot): void {
    if (this.jobs.has(key)) this.jobs.delete(key);
    this.jobs.set(key, snapshot);
    while (this.jobs.size > this.maxRetainedJobs) {
      const oldest = this.jobs.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.jobs.delete(oldest);
    }
  }

  private storeArtifact(identity: LocalComputeArtifactIdentity, canonical: CanonicalizedJson): boolean {
    if (identity.byteLength > this.maxArtifactStoreBytes) return false;
    const existing = this.artifacts.get(identity.artifactId);
    if (existing) return existing.identity.contentHash === identity.contentHash && existing.identity.byteLength === identity.byteLength;
    while (this.artifactStoreBytes + identity.byteLength > this.maxArtifactStoreBytes && this.artifacts.size > 0) {
      const oldestKey = this.artifacts.keys().next().value as string | undefined;
      if (oldestKey === undefined) break;
      const oldest = this.artifacts.get(oldestKey)!;
      this.artifactStoreBytes -= oldest.identity.byteLength;
      this.artifacts.delete(oldestKey);
    }
    if (this.artifactStoreBytes + identity.byteLength > this.maxArtifactStoreBytes) return false;
    this.artifacts.set(identity.artifactId, { encoded: canonical.encoded, identity });
    this.artifactStoreBytes += identity.byteLength;
    return true;
  }

  private reject(evidence: string, status: 'rejected' | 'unsupported' = 'rejected'): ComputerActionResult {
    return { status, dispatch: 'not-dispatched', verification: 'rejected', evidence: [evidence] };
  }

  private resultForEvictedLedger(entry: ExecutionLedgerEntry): ComputerActionResult {
    return {
      status: 'unknown',
      dispatch: entry.dispatch,
      verification: 'unverified',
      evidence: ['compute-job-state-evicted'],
      details: { executionState: entry.executionState },
    };
  }

  private resultForKnown(snapshot: LocalComputeJobSnapshot): ComputerActionResult {
    if (snapshot.executionState === 'unknown') {
      return { status: 'unknown', dispatch: snapshot.dispatch, verification: 'unverified', evidence: ['compute-known-dispatch-unknown'], details: { job: snapshot } };
    }
    if (snapshot.executionState === 'completed') {
      return { status: 'completed', dispatch: snapshot.dispatch, verification: 'verified', evidence: ['compute-known-job'], details: { job: snapshot } };
    }
    if (snapshot.executionState === 'failed' || snapshot.executionState === 'timed-out' || snapshot.executionState === 'output-limited') {
      return { status: 'failed', dispatch: snapshot.dispatch, verification: 'rejected', evidence: ['compute-known-job-failed'], details: { job: snapshot } };
    }
    return { status: 'unknown', dispatch: snapshot.dispatch, verification: 'unverified', evidence: ['compute-known-job-incomplete'], details: { job: snapshot } };
  }
}

export function localComputeJobEntity(adapterId: string, identity: LocalComputeIdentity): ComputerEntityRef {
  return { adapterId, environment: 'local-compute', kind: 'compute-job', entityId: identity.jobId, generation: identity.generation };
}
