import { TaskRuntime } from '../agent/taskRuntime.js';
import type { TaskRuntimeEngine, TaskRuntimeOptions, TaskRunResult } from '../agent/taskRuntime.js';
import type {
  BoundedSemanticSnapshotLimits,
  BoundedSemanticSnapshotResult,
} from '../browser/boundedSemanticSnapshot.js';
import type { DocumentContentSnapshot } from '../browser/documentContent.js';
import type { MediaStateSnapshot, ObserveMediaStateOptions } from '../browser/mediaState.js';
import type { VisualCaptureOptions, VisualSnapshot } from '../browser/visualObserver.js';
import type { BrowserTargetState } from '../browser/targetController.js';
import type { InteractionNode } from '../types.js';
import {
  computerActionMayAutoRetry,
  validateComputerActionRequest,
  validateComputerObservationRequest,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEntityRef,
  type ComputerEnvironmentAdapter,
  type ComputerEnvironmentAdapterDescriptor,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
  type ComputerSurfaceRef,
  type ComputerVerificationState,
} from './environmentAdapter.js';

const DEFAULT_MAX_ITEMS = 128;
const DEFAULT_MAX_TEXT_BYTES = 32 * 1024;
const MAX_OBSERVATION_ITEMS = 256;
const MAX_OBSERVATION_TEXT_BYTES = 64 * 1024;
const MAX_OBSERVATION_DEPTH = 32;
const DEFAULT_VISUAL_MAX_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_ELEMENTS = 64;
const MAX_MEDIA_TEXT_LENGTH = 2048;
const MAX_TYPE_TEXT_BYTES = 64 * 1024;
const MAX_EXPECTED_VALUE_BYTES = 64 * 1024;
const MAX_KEY_BYTES = 64;
const MAX_TYPE_DELAY_MS = 1_000;
const MAX_TYPE_DELAY_BUDGET_MS = 30_000;
const MAX_SCROLL_DELTA = 100_000;
const MAX_EVIDENCE = 12;
const MAX_EVIDENCE_BYTES = 63;
const MAX_RUNTIME_NO_PROGRESS = 16;
const MAX_RUNTIME_POLL_COUNT = 32;
const MAX_RUNTIME_POLL_INTERVAL_MS = 5_000;
const MAX_FRAME_DOCUMENT_TOKENS = 32;
const MAX_FRAME_DOCUMENT_TOKEN_BYTES = 4 * 1024;
const FRAME_DOCUMENT_TOKENS_INCOMPLETE = '__browser_identity_incomplete__';
const BOUNDED_ACTION_SEMANTIC_LIMITS: Readonly<BoundedSemanticSnapshotLimits> = Object.freeze({
  maxItems: MAX_OBSERVATION_ITEMS,
  maxTextBytes: MAX_OBSERVATION_TEXT_BYTES,
  maxDepth: MAX_OBSERVATION_DEPTH,
});

type BrowserRuntimePolicy = Omit<TaskRuntimeOptions, 'maxSteps' | 'maxVisitsPerStep' | 'commitmentDetection' | 'commitmentVerification'>;
const RUNTIME_POLICY_KEYS = [
  'maxConsecutiveNoProgress',
  'requireUnambiguousTargets',
  'maxRisk',
  'commitmentVerificationMaxPolls',
  'commitmentVerificationPollIntervalMs',
  'approve',
  'onCommitmentVerification',
  'onTrace',
  'waitPollIntervalMs',
  'waitMaxPolls',
] as const satisfies readonly (keyof BrowserRuntimePolicy)[];

export type BrowserComputerCapability =
  | 'browser.semantic-ui.observe'
  | 'browser.document.observe'
  | 'browser.visual.observe'
  | 'browser.media.observe'
  | 'browser.activate'
  | 'browser.hover'
  | 'browser.type'
  | 'browser.press-key'
  | 'browser.scroll-viewport';

export interface BrowserActivatePayload {
  method?: 'auto' | 'keyboard' | 'pointer';
  key?: string;
}
export interface BrowserTypePayload { text: string; expectedValue?: string; delayMs?: number; }
export interface BrowserPressKeyPayload { key: string; }
export interface BrowserScrollPayload { deltaX?: number; deltaY?: number; }
export interface BrowserFrameDocumentTokenLimits { maxFrames: number; maxTextBytes: number; }

interface BrowserBoundedActivateOptions {
  requireUnambiguous?: boolean;
  autoReveal?: boolean;
  method?: 'auto' | 'keyboard' | 'pointer';
  key?: string;
}
interface BrowserBoundedHoverOptions {
  requireUnambiguous?: boolean;
  autoReveal?: boolean;
  timeoutMs?: number;
  maxSamples?: number;
  pollIntervalMs?: number;
}
interface BrowserBoundedTypeOptions {
  requireUnambiguous?: boolean;
  autoReveal?: boolean;
  delayMs?: number;
  expectedValue?: string;
}

/** Browser-specific runtime hooks stay outside the neutral computer contracts. */
export interface BrowserComputerRuntime extends TaskRuntimeEngine {
  browserTargets?(): BrowserTargetState[];
  frameDocumentTokens?(
    targetId: string | undefined,
    limits: BrowserFrameDocumentTokenLimits,
  ): Promise<Readonly<Record<string, string>> | undefined>;
  semanticSnapshot?(
    targetId: string | undefined,
    limits: BoundedSemanticSnapshotLimits,
  ): Promise<BoundedSemanticSnapshotResult | undefined>;
  resolveBoundedSemanticTarget?(
    targetId: string | undefined,
    entityId: string,
    limits: BoundedSemanticSnapshotLimits,
  ): Promise<InteractionNode | undefined>;
  activateBoundedSemantic?(
    targetId: string | undefined,
    entityId: string,
    limits: BoundedSemanticSnapshotLimits,
    options?: BrowserBoundedActivateOptions,
  ): Promise<{ status: string; target: InteractionNode | null }>;
  hoverBoundedSemantic?(
    targetId: string | undefined,
    entityId: string,
    limits: BoundedSemanticSnapshotLimits,
    options?: BrowserBoundedHoverOptions,
  ): Promise<{ status: string; target: InteractionNode | null }>;
  typeBoundedSemantic?(
    targetId: string | undefined,
    entityId: string,
    text: string,
    limits: BoundedSemanticSnapshotLimits,
    options?: BrowserBoundedTypeOptions,
  ): Promise<{ status: string; target: InteractionNode | null }>;
  visualSnapshot?(targetId: string | undefined, options?: VisualCaptureOptions): Promise<VisualSnapshot | undefined>;
  mediaSnapshot?(targetId: string | undefined, options?: ObserveMediaStateOptions): Promise<MediaStateSnapshot | undefined>;
}

export interface BrowserComputerEnvironmentAdapterOptions {
  adapterId?: string;
  version?: string;
  /** Passed to the existing browser TaskRuntime commitment gate/verifier. */
  runtimeOptions?: BrowserRuntimePolicy;
}

interface BoundedSemanticNode {
  entity: ComputerEntityRef;
  role?: string;
  name?: string;
  value?: string;
  focused: boolean;
  disabled: boolean;
  visible: boolean;
  capabilities: readonly string[];
}
interface BrowserDocumentIdentity {
  topToken: string;
  frameTokens: Readonly<Record<string, string>>;
  complete: boolean;
}
interface ResolvedEntity {
  node: InteractionNode;
  surface: ComputerSurfaceRef;
  identity: BrowserDocumentIdentity;
  frameToken: string;
  structuralId: string;
}

function utf8Bytes(value: string): number { return new TextEncoder().encode(value).byteLength; }
function truncateUtf8(value: string, remaining: number): { value: string; bytes: number; truncated: boolean } {
  if (remaining <= 0) return { value: '', bytes: 0, truncated: value.length > 0 };
  const size = utf8Bytes(value);
  if (size <= remaining) return { value, bytes: size, truncated: false };
  let result = '', bytes = 0;
  for (const char of value) {
    const charBytes = utf8Bytes(char);
    if (bytes + charBytes > remaining) break;
    result += char;
    bytes += charBytes;
  }
  return { value: result, bytes, truncated: true };
}
function boundedEvidence(values: readonly string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (result.length >= MAX_EVIDENCE) break;
    if (!/^[a-z0-9][a-z0-9._:-]*$/i.test(value)) continue;
    const bounded = truncateUtf8(value, MAX_EVIDENCE_BYTES).value;
    if (bounded) result.push(bounded);
  }
  return result;
}
function failedPreDispatch(code: string, status: ComputerActionResult['status'] = 'rejected'): ComputerActionResult {
  return { status, dispatch: 'not-dispatched', verification: 'not-applicable', evidence: [code] };
}
function unknownAfterInvocation(code: string): ComputerActionResult {
  return { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: [code] };
}
function verificationFromTaskStatus(status: TaskRunResult['status']): ComputerVerificationState {
  switch (status) {
    case 'completed': return 'verified';
    case 'side-effect-pending': return 'pending';
    case 'side-effect-declined': case 'side-effect-canceled': return 'rejected';
    case 'side-effect-mismatch': return 'mismatch';
    case 'side-effect-unverified': default: return 'unverified';
  }
}
function boundedPositive(value: number | undefined, fallback: number, ceiling: number): number {
  return Math.min(value ?? fallback, ceiling);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function plainDataRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain data object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain data object`);
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) throw new TypeError(`${label}.${key} must be a data property`);
  }
  return value;
}
function dataProperty(record: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}
function snapshotEntityRef(value: unknown): Readonly<ComputerEntityRef> | undefined {
  if (value === undefined) return undefined;
  const source = plainDataRecord(value, 'browser action target');
  return Object.freeze({
    adapterId: dataProperty(source, 'adapterId'),
    environment: dataProperty(source, 'environment'),
    kind: dataProperty(source, 'kind'),
    entityId: dataProperty(source, 'entityId'),
    ...(dataProperty(source, 'surfaceId') !== undefined ? { surfaceId: dataProperty(source, 'surfaceId') } : {}),
    ...(dataProperty(source, 'generation') !== undefined ? { generation: dataProperty(source, 'generation') } : {}),
  } as ComputerEntityRef);
}
function snapshotActionRequest(value: unknown): Readonly<ComputerActionRequest> {
  const source = plainDataRecord(value, 'browser action request');
  const target = snapshotEntityRef(dataProperty(source, 'target'));
  return Object.freeze({
    adapterId: dataProperty(source, 'adapterId'),
    actionId: dataProperty(source, 'actionId'),
    capability: dataProperty(source, 'capability'),
    effect: dataProperty(source, 'effect'),
    idempotency: dataProperty(source, 'idempotency'),
    ...(target ? { target } : {}),
    ...(Object.getOwnPropertyDescriptor(source, 'payload') ? { payload: dataProperty(source, 'payload') } : {}),
  } as ComputerActionRequest);
}
function snapshotObservationSurface(value: unknown): Readonly<ComputerSurfaceRef> | undefined {
  if (value === undefined) return undefined;
  const source = plainDataRecord(value, 'browser observation surface');
  return Object.freeze({
    adapterId: dataProperty(source, 'adapterId'),
    environment: dataProperty(source, 'environment'),
    surfaceId: dataProperty(source, 'surfaceId'),
    ...(dataProperty(source, 'generation') !== undefined ? { generation: dataProperty(source, 'generation') } : {}),
    ...(dataProperty(source, 'parentSurfaceId') !== undefined ? { parentSurfaceId: dataProperty(source, 'parentSurfaceId') } : {}),
  } as ComputerSurfaceRef);
}
function snapshotObservationTarget(value: unknown): Readonly<ComputerEntityRef> | undefined {
  if (value === undefined) return undefined;
  const source = plainDataRecord(value, 'browser observation target');
  return Object.freeze({
    adapterId: dataProperty(source, 'adapterId'),
    environment: dataProperty(source, 'environment'),
    kind: dataProperty(source, 'kind'),
    entityId: dataProperty(source, 'entityId'),
    ...(dataProperty(source, 'surfaceId') !== undefined ? { surfaceId: dataProperty(source, 'surfaceId') } : {}),
    ...(dataProperty(source, 'generation') !== undefined ? { generation: dataProperty(source, 'generation') } : {}),
  } as ComputerEntityRef);
}
function snapshotObservationLimits(value: unknown): Readonly<NonNullable<ComputerObservationRequest['limits']>> | undefined {
  if (value === undefined) return undefined;
  const source = plainDataRecord(value, 'browser observation limits');
  return Object.freeze({
    ...(dataProperty(source, 'maxItems') !== undefined ? { maxItems: dataProperty(source, 'maxItems') } : {}),
    ...(dataProperty(source, 'maxTextBytes') !== undefined ? { maxTextBytes: dataProperty(source, 'maxTextBytes') } : {}),
    ...(dataProperty(source, 'maxDepth') !== undefined ? { maxDepth: dataProperty(source, 'maxDepth') } : {}),
  } as NonNullable<ComputerObservationRequest['limits']>);
}
function snapshotObservationRequest(value: unknown): Readonly<ComputerObservationRequest> {
  const source = plainDataRecord(value, 'browser observation request');
  const surface = snapshotObservationSurface(dataProperty(source, 'surface'));
  const target = snapshotObservationTarget(dataProperty(source, 'target'));
  const limits = snapshotObservationLimits(dataProperty(source, 'limits'));
  return Object.freeze({
    adapterId: dataProperty(source, 'adapterId'),
    channel: dataProperty(source, 'channel'),
    ...(surface ? { surface } : {}),
    ...(target ? { target } : {}),
    ...(limits ? { limits } : {}),
  } as ComputerObservationRequest);
}
function plainPayload(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  try { return plainDataRecord(value, 'browser action payload'); } catch { return undefined; }
}
function validateRuntimePolicyValue(key: keyof BrowserRuntimePolicy, value: unknown): void {
  if (value === undefined) return;
  switch (key) {
    case 'maxRisk':
      if (value !== 'observe' && value !== 'interaction' && value !== 'external-side-effect') {
        throw new TypeError('browser runtime options.maxRisk is invalid');
      }
      return;
    case 'requireUnambiguousTargets':
      if (typeof value !== 'boolean') throw new TypeError('browser runtime options.requireUnambiguousTargets must be a boolean');
      return;
    case 'maxConsecutiveNoProgress':
      if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_RUNTIME_NO_PROGRESS) {
        throw new TypeError(`browser runtime options.${key} must be an integer between 1 and ${MAX_RUNTIME_NO_PROGRESS}`);
      }
      return;
    case 'commitmentVerificationMaxPolls':
    case 'waitMaxPolls':
      if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_RUNTIME_POLL_COUNT) {
        throw new TypeError(`browser runtime options.${key} must be an integer between 1 and ${MAX_RUNTIME_POLL_COUNT}`);
      }
      return;
    case 'commitmentVerificationPollIntervalMs':
    case 'waitPollIntervalMs':
      if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > MAX_RUNTIME_POLL_INTERVAL_MS) {
        throw new TypeError(`browser runtime options.${key} must be an integer between 0 and ${MAX_RUNTIME_POLL_INTERVAL_MS}`);
      }
      return;
    case 'approve':
    case 'onCommitmentVerification':
    case 'onTrace':
      if (typeof value !== 'function') throw new TypeError(`browser runtime options.${key} must be a function`);
      return;
  }
}
function snapshotAdapterOptions(options: BrowserComputerEnvironmentAdapterOptions): Readonly<BrowserComputerEnvironmentAdapterOptions> {
  const root = plainDataRecord(options, 'browser adapter options');
  const adapterId = Object.getOwnPropertyDescriptor(root, 'adapterId')?.value;
  const version = Object.getOwnPropertyDescriptor(root, 'version')?.value;
  const runtimeCandidate = Object.getOwnPropertyDescriptor(root, 'runtimeOptions')?.value;
  if (adapterId !== undefined && typeof adapterId !== 'string') throw new TypeError('browser adapter options.adapterId must be a string');
  if (version !== undefined && typeof version !== 'string') throw new TypeError('browser adapter options.version must be a string');
  let runtimeOptions: Readonly<BrowserRuntimePolicy> | undefined;
  if (runtimeCandidate !== undefined) {
    const source = plainDataRecord(runtimeCandidate, 'browser runtime options');
    const snapshot: Partial<BrowserRuntimePolicy> = {};
    for (const key of RUNTIME_POLICY_KEYS) {
      const descriptor = Object.getOwnPropertyDescriptor(source, key);
      if (descriptor) {
        validateRuntimePolicyValue(key, descriptor.value);
        (snapshot as Record<string, unknown>)[key] = descriptor.value;
      }
    }
    runtimeOptions = Object.freeze(snapshot as BrowserRuntimePolicy);
  }
  return Object.freeze({
    ...(adapterId !== undefined ? { adapterId } : {}),
    ...(version !== undefined ? { version } : {}),
    ...(runtimeOptions ? { runtimeOptions } : {}),
  });
}
function boundedKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && utf8Bytes(value) <= MAX_KEY_BYTES && !/[\r\n\0]/.test(value);
}
function validateActivatePayload(value: unknown): BrowserActivatePayload | undefined {
  if (value === undefined) return {};
  const record = plainPayload(value);
  if (!record) return undefined;
  const method = dataProperty(record, 'method'), key = dataProperty(record, 'key');
  if (method !== undefined && method !== 'auto' && method !== 'keyboard' && method !== 'pointer') return undefined;
  if (key !== undefined && !boundedKey(key)) return undefined;
  return { ...(method !== undefined ? { method } : {}), ...(key !== undefined ? { key } : {}) } as BrowserActivatePayload;
}
function validateTypePayload(value: unknown): BrowserTypePayload | undefined {
  const record = plainPayload(value);
  if (!record) return undefined;
  const text = dataProperty(record, 'text');
  const expectedValue = dataProperty(record, 'expectedValue');
  const rawDelayMs = dataProperty(record, 'delayMs');
  if (typeof text !== 'string' || utf8Bytes(text) > MAX_TYPE_TEXT_BYTES) return undefined;
  if (expectedValue !== undefined && (typeof expectedValue !== 'string' || utf8Bytes(expectedValue) > MAX_EXPECTED_VALUE_BYTES)) return undefined;
  if (rawDelayMs !== undefined && (!Number.isSafeInteger(rawDelayMs) || (rawDelayMs as number) < 0 || (rawDelayMs as number) > MAX_TYPE_DELAY_MS)) return undefined;
  const delayMs = rawDelayMs as number | undefined;
  if (delayMs !== undefined && [...text].length * delayMs > MAX_TYPE_DELAY_BUDGET_MS) return undefined;
  return {
    text,
    ...(expectedValue !== undefined ? { expectedValue: expectedValue as string } : {}),
    ...(delayMs !== undefined ? { delayMs } : {}),
  };
}
function validatePressKeyPayload(value: unknown): BrowserPressKeyPayload | undefined {
  const record = plainPayload(value);
  const key = record ? dataProperty(record, 'key') : undefined;
  return boundedKey(key) ? { key } : undefined;
}
function validateScrollPayload(value: unknown): BrowserScrollPayload | undefined {
  if (value === undefined) return undefined;
  const record = plainPayload(value);
  if (!record) return undefined;
  const deltaX = dataProperty(record, 'deltaX') ?? 0, deltaY = dataProperty(record, 'deltaY') ?? 0;
  if (typeof deltaX !== 'number' || typeof deltaY !== 'number' || !Number.isFinite(deltaX) || !Number.isFinite(deltaY) ||
      Math.abs(deltaX) > MAX_SCROLL_DELTA || Math.abs(deltaY) > MAX_SCROLL_DELTA || (deltaX === 0 && deltaY === 0)) return undefined;
  return { deltaX, deltaY };
}
function documentToken(timeOrigin: number): string | undefined {
  return Number.isFinite(timeOrigin) && timeOrigin >= 0 ? timeOrigin.toString(36) : undefined;
}
function boundedDocumentToken(value: string): boolean {
  return value.length > 0 && utf8Bytes(value) <= 128 && !/[\r\n\0]/.test(value);
}
function sameDocumentIdentity(left: BrowserDocumentIdentity, right: BrowserDocumentIdentity): boolean {
  if (left.topToken !== right.topToken || left.complete !== right.complete) return false;
  const leftEntries = Object.entries(left.frameTokens).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right.frameTokens).sort(([a], [b]) => a.localeCompare(b));
  if (leftEntries.length !== rightEntries.length) return false;
  return leftEntries.every(([frameId, token], index) => frameId === rightEntries[index]?.[0] && token === rightEntries[index]?.[1]);
}

export class BrowserComputerEnvironmentAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor;
  readonly options: Readonly<BrowserComputerEnvironmentAdapterOptions>;
  private sequence = 0;
  private readonly activeDocumentIdentities = new Map<string, BrowserDocumentIdentity>();

  constructor(readonly runtime: BrowserComputerRuntime, options: BrowserComputerEnvironmentAdapterOptions = {}) {
    this.options = snapshotAdapterOptions(options);
    const capabilities = Object.freeze([
      'browser.semantic-ui.observe', 'browser.document.observe', 'browser.visual.observe', 'browser.media.observe',
      'browser.activate', 'browser.hover', 'browser.type', 'browser.press-key', 'browser.scroll-viewport',
    ]);
    this.descriptor = Object.freeze({
      id: this.options.adapterId ?? 'browser-chromium', kind: 'browser', version: this.options.version ?? '0.43', capabilities,
    });
  }

  private targetById(targetId: string): BrowserTargetState | undefined {
    const exact = this.runtime.browserTargets?.().find((candidate) => candidate.targetId === targetId);
    if (exact) return exact;
    const summary = this.runtime.targetState?.();
    return [summary?.latestPage, summary?.latestUnattachedPage].find((candidate) => candidate?.targetId === targetId);
  }
  surfaceForTarget(target: BrowserTargetState): ComputerSurfaceRef {
    return {
      adapterId: this.descriptor.id, environment: 'browser', surfaceId: target.targetId, generation: target.sequence,
      ...(target.openerId ? { parentSurfaceId: target.openerId } : {}),
    };
  }
  currentSurface(): ComputerSurfaceRef | undefined {
    const targetId = this.runtime.activePageTargetId?.();
    if (!targetId) return undefined;
    const target = this.targetById(targetId);
    return target ? this.surfaceForTarget(target) : undefined;
  }
  private validateSurface(surface: ComputerSurfaceRef | undefined): { ok: true } | { ok: false; code: string } {
    if (!surface) return { ok: true };
    if (surface.adapterId !== this.descriptor.id || surface.environment !== 'browser') return { ok: false, code: 'browser.surface.adapter-mismatch' };
    const target = this.targetById(surface.surfaceId);
    if (!target) return { ok: false, code: 'browser.surface.stale' };
    if (surface.generation === undefined || surface.generation !== target.sequence) return { ok: false, code: 'browser.surface.generation-mismatch' };
    return { ok: true };
  }
  private async activeDocumentIdentity(surface: ComputerSurfaceRef): Promise<BrowserDocumentIdentity | undefined> {
    if (this.runtime.activePageTargetId?.() !== surface.surfaceId) return undefined;
    const [state, suppliedFrameTokens] = await Promise.all([
      this.runtime.browserState?.(),
      this.runtime.frameDocumentTokens?.(surface.surfaceId, {
        maxFrames: MAX_FRAME_DOCUMENT_TOKENS,
        maxTextBytes: MAX_FRAME_DOCUMENT_TOKEN_BYTES,
      }),
    ]);
    if (!state) return undefined;
    const topToken = documentToken(state.timeOrigin);
    if (!topToken) return undefined;
    const frameTokens: Record<string, string> = {};
    let complete = suppliedFrameTokens?.[FRAME_DOCUMENT_TOKENS_INCOMPLETE] !== '1';
    let count = 0;
    let bytes = 0;
    if (suppliedFrameTokens) {
      for (const frameId in suppliedFrameTokens) {
        if (!Object.prototype.hasOwnProperty.call(suppliedFrameTokens, frameId)) continue;
        if (frameId === FRAME_DOCUMENT_TOKENS_INCOMPLETE) { complete = false; continue; }
        count += 1;
        if (count > MAX_FRAME_DOCUMENT_TOKENS) { complete = false; break; }
        const descriptor = Object.getOwnPropertyDescriptor(suppliedFrameTokens, frameId);
        if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'string') { complete = false; break; }
        const token = descriptor.value;
        const entryBytes = utf8Bytes(frameId) + utf8Bytes(token);
        if (bytes + entryBytes > MAX_FRAME_DOCUMENT_TOKEN_BYTES) { complete = false; break; }
        bytes += entryBytes;
        if (frameId && boundedDocumentToken(frameId) && boundedDocumentToken(token)) frameTokens[frameId] = token;
        else complete = false;
      }
    } else {
      complete = false;
    }
    frameTokens.main = topToken;
    const identity = { topToken, frameTokens, complete };
    this.activeDocumentIdentities.set(surface.surfaceId, identity);
    return identity;
  }
  entityForNode(
    node: InteractionNode,
    surface = this.currentSurface(),
    identity = surface ? this.activeDocumentIdentities.get(surface.surfaceId) : undefined,
  ): ComputerEntityRef {
    const stableId = node.backendNodeId !== undefined ? `backend:${node.backendNodeId}` : `node:${encodeURIComponent(node.id)}`;
    const frameToken = identity && (node.frameId === 'main' || identity.complete) ? identity.frameTokens[node.frameId] : undefined;
    const boundId = identity && frameToken
      ? node.frameId === 'main'
        ? `doc:${identity.topToken}:frame:${encodeURIComponent(node.frameId)}:${stableId}`
        : `doc:${identity.topToken}:frame:${encodeURIComponent(node.frameId)}:gen:${encodeURIComponent(frameToken)}:${stableId}`
      : undefined;
    return {
      adapterId: this.descriptor.id,
      environment: 'browser',
      kind: 'ui-control',
      entityId: boundId ?? `unbound:frame:${encodeURIComponent(node.frameId)}:${stableId}`,
      ...(surface ? { surfaceId: surface.surfaceId, generation: surface.generation } : {}),
    };
  }
  private async resolveEntity(target: ComputerEntityRef | undefined): Promise<ResolvedEntity | undefined> {
    if (!target || target.adapterId !== this.descriptor.id || target.environment !== 'browser' || target.kind !== 'ui-control' || !target.surfaceId || target.generation === undefined) return undefined;
    if (!this.runtime.resolveBoundedSemanticTarget) return undefined;
    const browserTarget = this.targetById(target.surfaceId);
    if (!browserTarget || target.generation !== browserTarget.sequence || this.runtime.activePageTargetId?.() !== target.surfaceId) return undefined;
    const surface = this.surfaceForTarget(browserTarget);
    const match = /^doc:([^:]+):frame:([^:]+)(?::gen:([^:]+))?:(backend:(\d+)|node:(.+))$/.exec(target.entityId);
    if (!match || match[6] === undefined) return undefined;
    let frameId: string, explicitFrameToken: string | undefined, structuralId: string;
    try {
      frameId = decodeURIComponent(match[2]);
      explicitFrameToken = match[3] === undefined ? undefined : decodeURIComponent(match[3]);
      structuralId = decodeURIComponent(match[6]);
    } catch { return undefined; }
    if (frameId !== 'main' && explicitFrameToken === undefined) return undefined;
    if (frameId === 'main' && explicitFrameToken !== undefined) return undefined;
    const expectedFrameToken = explicitFrameToken ?? match[1];
    const before = await this.activeDocumentIdentity(surface);
    if (!before || (frameId !== 'main' && !before.complete) || before.topToken !== match[1] || before.frameTokens[frameId] !== expectedFrameToken) return undefined;
    const node = await this.runtime.resolveBoundedSemanticTarget(surface.surfaceId, structuralId, BOUNDED_ACTION_SEMANTIC_LIMITS);
    const after = await this.activeDocumentIdentity(surface);
    if (!after || (frameId !== 'main' && !after.complete) || !sameDocumentIdentity(before, after) || after.topToken !== match[1] || after.frameTokens[frameId] !== expectedFrameToken) return undefined;
    if (!node || node.frameId !== frameId || (node.id !== structuralId && node.structuralId !== structuralId)) return undefined;
    return { node, surface, identity: after, frameToken: expectedFrameToken, structuralId };
  }
  private async boundedObservedTarget(
    target: ComputerEntityRef,
    nodes: readonly InteractionNode[],
    identity: BrowserDocumentIdentity,
  ): Promise<InteractionNode | undefined> {
    const match = /^doc:([^:]+):frame:([^:]+)(?::gen:([^:]+))?:node:(.+)$/.exec(target.entityId);
    if (!match) return undefined;
    let frameId: string, explicitFrameToken: string | undefined, nodeId: string;
    try {
      frameId = decodeURIComponent(match[2]);
      explicitFrameToken = match[3] === undefined ? undefined : decodeURIComponent(match[3]);
      nodeId = decodeURIComponent(match[4]);
    } catch { return undefined; }
    if (frameId !== 'main' && (!identity.complete || explicitFrameToken === undefined)) return undefined;
    if (frameId === 'main' && explicitFrameToken !== undefined) return undefined;
    const expectedFrameToken = explicitFrameToken ?? match[1];
    if (identity.topToken !== match[1] || identity.frameTokens[frameId] !== expectedFrameToken) return undefined;
    return nodes.find((candidate) =>
      candidate.frameId === frameId && (candidate.id === nodeId || candidate.structuralId === nodeId));
  }
  private async entityIdentityCurrent(resolved: ResolvedEntity): Promise<boolean> {
    const current = await this.activeDocumentIdentity(resolved.surface);
    return current !== undefined &&
      (resolved.node.frameId === 'main' || current.complete) &&
      current.topToken === resolved.identity.topToken &&
      current.frameTokens[resolved.node.frameId] === resolved.frameToken;
  }
  private boundSemantic(nodes: readonly InteractionNode[], surface: ComputerSurfaceRef, identity: BrowserDocumentIdentity, request: ComputerObservationRequest): { data: BoundedSemanticNode[]; truncated: boolean } {
    const maxItems = boundedPositive(request.limits?.maxItems, DEFAULT_MAX_ITEMS, MAX_OBSERVATION_ITEMS);
    const maxTextBytes = boundedPositive(request.limits?.maxTextBytes, DEFAULT_MAX_TEXT_BYTES, MAX_OBSERVATION_TEXT_BYTES);
    const data: BoundedSemanticNode[] = [];
    let textBytes = 0, truncated = nodes.length > maxItems;
    for (const node of nodes.slice(0, maxItems)) {
      if ((node.frameId !== 'main' && !identity.complete) || !identity.frameTokens[node.frameId]) throw new Error('browser.frame.identity-unavailable');
      const bounded: BoundedSemanticNode = {
        entity: this.entityForNode(node, surface, identity), focused: node.focused, disabled: node.disabled,
        visible: node.mainViewportVisible !== false && node.viewportVisible !== false,
        capabilities: [...node.capabilities].slice(0, 32),
      };
      for (const field of ['role', 'name', 'value'] as const) {
        const source = node[field];
        if (typeof source !== 'string') continue;
        const piece = truncateUtf8(source, Math.max(0, maxTextBytes - textBytes));
        if (piece.value) bounded[field] = piece.value;
        textBytes += piece.bytes;
        truncated ||= piece.truncated;
      }
      data.push(bounded);
      if (textBytes >= maxTextBytes) { truncated = true; break; }
    }
    return { data, truncated };
  }
  private observationTargetSurface(request: ComputerObservationRequest): ComputerSurfaceRef | undefined {
    if (request.surface) return request.surface;
    if (!request.target?.surfaceId || request.target.generation === undefined) return undefined;
    const target = this.targetById(request.target.surfaceId);
    return target && target.sequence === request.target.generation ? this.surfaceForTarget(target) : undefined;
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    let authority: Readonly<ComputerObservationRequest>;
    try { authority = snapshotObservationRequest(request); }
    catch { throw new Error('invalid computer observation request: browser.request.invalid-envelope'); }
    const errors = validateComputerObservationRequest(authority as ComputerObservationRequest, this.descriptor);
    if (errors.length) throw new Error(`invalid computer observation request: ${errors.join('; ')}`);
    if (authority.target && authority.channel !== 'semantic-ui') throw new Error('browser.observation.target-unsupported');
    if (authority.target && (authority.target.kind !== 'ui-control' || !authority.target.surfaceId || authority.target.generation === undefined)) throw new Error('browser.observation.target-invalid');
    const requestedSurface = this.observationTargetSurface(authority as ComputerObservationRequest) ?? authority.surface;
    const surfaceCheck = this.validateSurface(requestedSurface);
    if (!surfaceCheck.ok) throw new Error(surfaceCheck.code);
    const surface = requestedSurface ?? this.currentSurface();
    const sequence = ++this.sequence;

    if (authority.channel === 'semantic-ui') {
      if (!surface || this.runtime.activePageTargetId?.() !== surface.surfaceId) throw new Error('browser.surface.not-active');
      if (!this.runtime.semanticSnapshot) throw new Error('browser.semantic.unsupported');
      const maxItems = boundedPositive(authority.limits?.maxItems, DEFAULT_MAX_ITEMS, MAX_OBSERVATION_ITEMS);
      const maxTextBytes = boundedPositive(authority.limits?.maxTextBytes, DEFAULT_MAX_TEXT_BYTES, MAX_OBSERVATION_TEXT_BYTES);
      const maxDepth = boundedPositive(authority.limits?.maxDepth, MAX_OBSERVATION_DEPTH, MAX_OBSERVATION_DEPTH);
      const before = await this.activeDocumentIdentity(surface);
      if (!before) throw new Error('browser.document.identity-unavailable');
      const snapshot = await this.runtime.semanticSnapshot(surface.surfaceId, { maxItems, maxTextBytes, maxDepth });
      if (!snapshot) throw new Error('browser.semantic.unavailable');
      const after = await this.activeDocumentIdentity(surface);
      if (!after || !sameDocumentIdentity(before, after)) throw new Error('browser.document.identity-changed');
      let nodes = snapshot.nodes;
      if (authority.target) {
        const exact = await this.boundedObservedTarget(authority.target, nodes, after);
        if (!exact) throw new Error('browser.observation.target-stale');
        nodes = [exact];
      }
      const bounded = this.boundSemantic(nodes, surface, after, authority as ComputerObservationRequest);
      const truncated = snapshot.truncated || bounded.truncated;
      return { adapterId: this.descriptor.id, environment: 'browser', channel: authority.channel, sequence, complete: snapshot.complete && !truncated, truncated, surface, ...(authority.target ? { target: authority.target } : {}), data: bounded.data };
    }
    if (authority.channel === 'document') {
      const maxBlocks = boundedPositive(authority.limits?.maxItems, DEFAULT_MAX_ITEMS, MAX_OBSERVATION_ITEMS);
      const maxTextBytes = boundedPositive(authority.limits?.maxTextBytes, DEFAULT_MAX_TEXT_BYTES, MAX_OBSERVATION_TEXT_BYTES);
      const maxDepth = boundedPositive(authority.limits?.maxDepth, MAX_OBSERVATION_DEPTH, MAX_OBSERVATION_DEPTH);
      let snapshot: DocumentContentSnapshot | undefined;
      if (surface?.surfaceId && this.runtime.documentContentForPage) snapshot = await this.runtime.documentContentForPage(surface.surfaceId, { maxBlocks, maxTextBytes, maxDepth });
      else snapshot = await this.runtime.documentContent?.({ maxBlocks, maxTextBytes, maxDepth });
      if (!snapshot) throw new Error('browser.document.unsupported');
      return { adapterId: this.descriptor.id, environment: 'browser', channel: authority.channel, sequence, complete: !snapshot.truncated && snapshot.frameErrors.length === 0, truncated: snapshot.truncated, ...(surface ? { surface } : {}), data: snapshot };
    }
    if (authority.channel === 'visual') {
      if (!this.runtime.visualSnapshot) throw new Error('browser.visual.unsupported');
      const maxBytes = Math.min(authority.limits?.maxTextBytes ?? DEFAULT_VISUAL_MAX_BYTES, DEFAULT_VISUAL_MAX_BYTES);
      const snapshot = await this.runtime.visualSnapshot(surface?.surfaceId, { maxBytes });
      if (!snapshot) throw new Error('browser.visual.unavailable');
      return { adapterId: this.descriptor.id, environment: 'browser', channel: authority.channel, sequence, complete: true, truncated: false, ...(surface ? { surface } : {}), data: snapshot };
    }
    if (authority.channel === 'media') {
      if (!this.runtime.mediaSnapshot) throw new Error('browser.media.unsupported');
      const snapshot = await this.runtime.mediaSnapshot(surface?.surfaceId, {
        maxMediaElements: boundedPositive(authority.limits?.maxItems, 32, MAX_MEDIA_ELEMENTS),
        maxFrames: boundedPositive(authority.limits?.maxDepth, 16, MAX_OBSERVATION_DEPTH),
        maxTextLength: boundedPositive(authority.limits?.maxTextBytes, 256, MAX_MEDIA_TEXT_LENGTH),
      });
      if (!snapshot) throw new Error('browser.media.unavailable');
      return { adapterId: this.descriptor.id, environment: 'browser', channel: authority.channel, sequence, complete: !snapshot.truncated && snapshot.errors.length === 0, truncated: snapshot.truncated, ...(surface ? { surface } : {}), data: snapshot };
    }
    throw new Error(`browser observation channel unsupported: ${authority.channel}`);
  }

  private taskResult(result: TaskRunResult): ComputerActionResult {
    const actionTrace = result.trace.find((entry) => entry.stepId === 'act');
    if (actionTrace?.outcome === 'policy-blocked') return failedPreDispatch('browser.commitment.policy-blocked');
    if (actionTrace?.outcome === 'exception') return unknownAfterInvocation('browser.dispatch.unknown');
    if (result.status === 'completed') return {
      status: 'completed', dispatch: 'dispatched-once', verification: 'verified',
      evidence: boundedEvidence(['browser.native-input', ...(actionTrace?.commitmentKind ? ['browser.commitment.delegated', `browser.commitment.${actionTrace.commitmentKind}`] : [])]),
    };
    if (result.status.startsWith('side-effect-')) return {
      status: result.status === 'side-effect-declined' || result.status === 'side-effect-canceled' ? 'rejected' : 'unknown',
      dispatch: 'dispatched-once', verification: verificationFromTaskStatus(result.status),
      evidence: boundedEvidence(['browser.commitment.delegated', `browser.${result.status}`]),
    };
    if (actionTrace) return unknownAfterInvocation(`browser.runtime.${result.status}`);
    return failedPreDispatch(`browser.runtime.${result.status}`, 'failed');
  }
  private runtimeForCommitment(resolved: ResolvedEntity | undefined, onStaleBeforeDispatch: () => void): BrowserComputerRuntime {
    if (!resolved) return this.runtime;
    const adapter = this;
    return new Proxy(this.runtime, {
      get(target, property) {
        if (property === 'refresh') {
          return async () => {
            const before = await adapter.activeDocumentIdentity(resolved.surface);
            if (!before || before.topToken !== resolved.identity.topToken || before.frameTokens[resolved.node.frameId] !== resolved.frameToken) return [];
            const snapshot = await target.semanticSnapshot?.(resolved.surface.surfaceId, BOUNDED_ACTION_SEMANTIC_LIMITS);
            const after = await adapter.activeDocumentIdentity(resolved.surface);
            if (!snapshot || !after || !sameDocumentIdentity(before, after)) return [];
            return snapshot.nodes;
          };
        }
        if (property === 'activate') {
          return async (_query: unknown, options?: BrowserBoundedActivateOptions) => {
            if (!(await adapter.entityIdentityCurrent(resolved))) {
              onStaleBeforeDispatch();
              return { status: 'target-not-found', target: null };
            }
            if (!target.activateBoundedSemantic) {
              onStaleBeforeDispatch();
              return { status: 'target-not-found', target: null };
            }
            return target.activateBoundedSemantic(
              resolved.surface.surfaceId,
              resolved.structuralId,
              BOUNDED_ACTION_SEMANTIC_LIMITS,
              options,
            );
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as BrowserComputerRuntime;
  }
  private async runCommitmentAwareAction(
    request: ComputerActionRequest,
    payload: BrowserActivatePayload | BrowserPressKeyPayload,
    resolved?: ResolvedEntity,
  ): Promise<ComputerActionResult> {
    let staleBeforeDispatch = false;
    const runtime = new TaskRuntime(this.runtimeForCommitment(resolved, () => { staleBeforeDispatch = true; }));
    const risk = request.effect === 'local-reversible' ? 'interaction' : 'external-side-effect';
    const action = request.capability === 'browser.activate'
      ? { id: 'act' as const, kind: 'activate' as const, target: { id: resolved!.structuralId, frameId: resolved!.node.frameId }, method: (payload as BrowserActivatePayload).method, key: (payload as BrowserActivatePayload).key, risk, next: 'done' as const }
      : { id: 'act' as const, kind: 'press-key' as const, key: (payload as BrowserPressKeyPayload).key, risk, next: 'done' as const };
    const result = await runtime.run({ version: 1, name: `computer-adapter:${request.actionId}`, entry: 'act', steps: [action, { id: 'done', kind: 'complete' }] }, {}, {
      ...this.options.runtimeOptions, maxSteps: 2, maxVisitsPerStep: 1, commitmentDetection: 'auto', commitmentVerification: 'auto',
    });
    if (staleBeforeDispatch) return failedPreDispatch('browser.target.stale-before-dispatch');
    return this.taskResult(result);
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    let authority: Readonly<ComputerActionRequest>;
    try { authority = snapshotActionRequest(request); }
    catch { return failedPreDispatch('browser.request.invalid'); }
    const errors = validateComputerActionRequest(authority as ComputerActionRequest, this.descriptor);
    if (errors.length) return failedPreDispatch('browser.request.invalid');
    if (!this.descriptor.capabilities.includes(authority.capability)) return failedPreDispatch('browser.capability.unsupported', 'unsupported');
    if (authority.capability.endsWith('.observe')) return authority.effect === 'observe-only' && authority.idempotency === 'read-only'
      ? { status: 'completed', dispatch: 'not-dispatched', verification: 'verified', evidence: ['browser.verified-noop'] }
      : failedPreDispatch('browser.effect.invalid');
    if (authority.effect === 'observe-only' || authority.idempotency === 'read-only') return failedPreDispatch('browser.effect.invalid');

    if (authority.capability === 'browser.activate') {
      const payload = validateActivatePayload(authority.payload);
      if (!payload) return failedPreDispatch('browser.payload.invalid');
      if (!this.runtime.resolveBoundedSemanticTarget || !this.runtime.activateBoundedSemantic) return failedPreDispatch('browser.bounded-action.unsupported', 'unsupported');
      const resolved = await this.resolveEntity(authority.target);
      if (!resolved) return failedPreDispatch('browser.target.stale');
      try { return await this.runCommitmentAwareAction(authority as ComputerActionRequest, payload, resolved); } catch { return unknownAfterInvocation('browser.dispatch.unknown'); }
    }
    if (authority.capability === 'browser.press-key') {
      if (authority.target) return failedPreDispatch('browser.target.unexpected');
      const payload = validatePressKeyPayload(authority.payload);
      if (!payload) return failedPreDispatch('browser.payload.invalid');
      try { return await this.runCommitmentAwareAction(authority as ComputerActionRequest, payload); } catch { return unknownAfterInvocation('browser.dispatch.unknown'); }
    }
    if (authority.effect !== 'local-reversible') return failedPreDispatch('browser.effect.unsupported');

    let invoked = false;
    try {
      if (authority.capability === 'browser.hover') {
        if (!this.runtime.resolveBoundedSemanticTarget || !this.runtime.hoverBoundedSemantic) return failedPreDispatch('browser.bounded-action.unsupported', 'unsupported');
        const resolved = await this.resolveEntity(authority.target);
        if (!resolved || !(await this.entityIdentityCurrent(resolved))) return failedPreDispatch('browser.target.stale');
        invoked = true;
        const result = await this.runtime.hoverBoundedSemantic(
          resolved.surface.surfaceId,
          resolved.structuralId,
          BOUNDED_ACTION_SEMANTIC_LIMITS,
          { requireUnambiguous: true, autoReveal: true },
        );
        return result.status === 'verified' ? { status: 'completed', dispatch: 'dispatched-once', verification: 'verified', evidence: ['browser.native-input'] } : { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: boundedEvidence([`browser.action.${result.status}`]) };
      }
      if (authority.capability === 'browser.type') {
        const payload = validateTypePayload(authority.payload);
        if (!payload) return failedPreDispatch('browser.payload.invalid');
        if (!this.runtime.resolveBoundedSemanticTarget || !this.runtime.typeBoundedSemantic) return failedPreDispatch('browser.bounded-action.unsupported', 'unsupported');
        const resolved = await this.resolveEntity(authority.target);
        if (!resolved || !(await this.entityIdentityCurrent(resolved))) return failedPreDispatch('browser.target.stale');
        invoked = true;
        const result = await this.runtime.typeBoundedSemantic(
          resolved.surface.surfaceId,
          resolved.structuralId,
          payload.text,
          BOUNDED_ACTION_SEMANTIC_LIMITS,
          { requireUnambiguous: true, autoReveal: true, delayMs: payload.delayMs, expectedValue: payload.expectedValue },
        );
        return result.status === 'verified' ? { status: 'completed', dispatch: 'dispatched-once', verification: 'verified', evidence: ['browser.native-input'] } : { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: boundedEvidence([`browser.action.${result.status}`]) };
      }
      if (authority.capability === 'browser.scroll-viewport') {
        if (authority.target) return failedPreDispatch('browser.target.unexpected');
        const payload = validateScrollPayload(authority.payload);
        if (!payload) return failedPreDispatch('browser.payload.invalid');
        invoked = true;
        const result = await this.runtime.scrollViewport?.({ x: payload.deltaX ?? 0, y: payload.deltaY ?? 0 });
        if (!result) return unknownAfterInvocation('browser.scroll.unsupported-after-invocation');
        return result.status === 'verified' ? { status: 'completed', dispatch: 'dispatched-once', verification: 'verified', evidence: ['browser.native-input'] } : { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: boundedEvidence([`browser.action.${result.status}`]) };
      }
      return failedPreDispatch('browser.capability.unsupported', 'unsupported');
    } catch {
      return invoked ? unknownAfterInvocation('browser.dispatch.unknown') : failedPreDispatch('browser.action.failed');
    }
  }

  mayAutoRetry(request: ComputerActionRequest, result: ComputerActionResult): boolean {
    if (!request.capability.endsWith('.observe') && (request.effect === 'observe-only' || request.idempotency === 'read-only')) return false;
    return computerActionMayAutoRetry(request, result);
  }
}
