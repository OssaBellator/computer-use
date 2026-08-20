import { TaskRuntime } from '../agent/taskRuntime.js';
import type { TaskRuntimeEngine, TaskRuntimeOptions, TaskRunResult } from '../agent/taskRuntime.js';
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

/** Browser-specific runtime hooks stay outside the neutral computer contracts. */
export interface BrowserComputerRuntime extends TaskRuntimeEngine {
  browserTargets?(): BrowserTargetState[];
  frameDocumentTokens?(targetId: string | undefined): Promise<Readonly<Record<string, string>> | undefined>;
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
}
interface ResolvedEntity {
  node: InteractionNode;
  surface: ComputerSurfaceRef;
  identity: BrowserDocumentIdentity;
  frameToken: string;
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
  if (!isRecord(value)) return undefined;
  const method = value.method, key = value.key;
  if (method !== undefined && method !== 'auto' && method !== 'keyboard' && method !== 'pointer') return undefined;
  if (key !== undefined && !boundedKey(key)) return undefined;
  return { ...(method !== undefined ? { method } : {}), ...(key !== undefined ? { key } : {}) } as BrowserActivatePayload;
}
function validateTypePayload(value: unknown): BrowserTypePayload | undefined {
  if (!isRecord(value) || typeof value.text !== 'string' || utf8Bytes(value.text) > MAX_TYPE_TEXT_BYTES) return undefined;
  if (value.expectedValue !== undefined && (typeof value.expectedValue !== 'string' || utf8Bytes(value.expectedValue) > MAX_EXPECTED_VALUE_BYTES)) return undefined;
  if (value.delayMs !== undefined && (!Number.isSafeInteger(value.delayMs) || (value.delayMs as number) < 0 || (value.delayMs as number) > MAX_TYPE_DELAY_MS)) return undefined;
  const delayMs = value.delayMs as number | undefined;
  if (delayMs !== undefined && [...value.text].length * delayMs > MAX_TYPE_DELAY_BUDGET_MS) return undefined;
  return {
    text: value.text,
    ...(value.expectedValue !== undefined ? { expectedValue: value.expectedValue as string } : {}),
    ...(delayMs !== undefined ? { delayMs } : {}),
  };
}
function validatePressKeyPayload(value: unknown): BrowserPressKeyPayload | undefined {
  return isRecord(value) && boundedKey(value.key) ? { key: value.key } : undefined;
}
function validateScrollPayload(value: unknown): BrowserScrollPayload | undefined {
  if (value !== undefined && !isRecord(value)) return undefined;
  const record = (value ?? {}) as Record<string, unknown>;
  const deltaX = record.deltaX ?? 0, deltaY = record.deltaY ?? 0;
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
  if (left.topToken !== right.topToken) return false;
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
      this.runtime.frameDocumentTokens?.(surface.surfaceId),
    ]);
    if (!state) return undefined;
    const topToken = documentToken(state.timeOrigin);
    if (!topToken) return undefined;
    const frameTokens: Record<string, string> = {};
    for (const [frameId, token] of Object.entries(suppliedFrameTokens ?? {})) {
      if (frameId && boundedDocumentToken(frameId) && boundedDocumentToken(token)) frameTokens[frameId] = token;
    }
    frameTokens.main = topToken;
    const identity = { topToken, frameTokens };
    this.activeDocumentIdentities.set(surface.surfaceId, identity);
    return identity;
  }
  entityForNode(
    node: InteractionNode,
    surface = this.currentSurface(),
    identity = surface ? this.activeDocumentIdentities.get(surface.surfaceId) : undefined,
  ): ComputerEntityRef {
    const stableId = node.backendNodeId !== undefined ? `backend:${node.backendNodeId}` : `node:${encodeURIComponent(node.id)}`;
    const frameToken = identity?.frameTokens[node.frameId];
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
    const browserTarget = this.targetById(target.surfaceId);
    if (!browserTarget || target.generation !== browserTarget.sequence || this.runtime.activePageTargetId?.() !== target.surfaceId) return undefined;
    const surface = this.surfaceForTarget(browserTarget);
    const match = /^doc:([^:]+):frame:([^:]+)(?::gen:([^:]+))?:(backend:(\d+)|node:(.+))$/.exec(target.entityId);
    if (!match) return undefined;
    let frameId: string, explicitFrameToken: string | undefined;
    try {
      frameId = decodeURIComponent(match[2]);
      explicitFrameToken = match[3] === undefined ? undefined : decodeURIComponent(match[3]);
    } catch { return undefined; }
    if (frameId !== 'main' && explicitFrameToken === undefined) return undefined;
    if (frameId === 'main' && explicitFrameToken !== undefined) return undefined;
    const expectedFrameToken = explicitFrameToken ?? match[1];
    const before = await this.activeDocumentIdentity(surface);
    if (!before || before.topToken !== match[1] || before.frameTokens[frameId] !== expectedFrameToken) return undefined;
    const nodes = await this.runtime.refresh();
    const after = await this.activeDocumentIdentity(surface);
    if (!after || !sameDocumentIdentity(before, after) || after.topToken !== match[1] || after.frameTokens[frameId] !== expectedFrameToken) return undefined;
    const backendNodeId = match[5] !== undefined ? Number(match[5]) : undefined;
    let nodeId: string | undefined;
    if (match[6] !== undefined) { try { nodeId = decodeURIComponent(match[6]); } catch { return undefined; } }
    const node = backendNodeId !== undefined
      ? nodes.find((candidate) => candidate.frameId === frameId && candidate.backendNodeId === backendNodeId)
      : nodes.find((candidate) => candidate.frameId === frameId && (candidate.id === nodeId || candidate.structuralId === nodeId));
    return node ? { node, surface, identity: after, frameToken: expectedFrameToken } : undefined;
  }
  private async entityIdentityCurrent(resolved: ResolvedEntity): Promise<boolean> {
    const current = await this.activeDocumentIdentity(resolved.surface);
    return current !== undefined && current.topToken === resolved.identity.topToken && current.frameTokens[resolved.node.frameId] === resolved.frameToken;
  }
  private boundSemantic(nodes: readonly InteractionNode[], surface: ComputerSurfaceRef, identity: BrowserDocumentIdentity, request: ComputerObservationRequest): { data: BoundedSemanticNode[]; truncated: boolean } {
    const maxItems = boundedPositive(request.limits?.maxItems, DEFAULT_MAX_ITEMS, MAX_OBSERVATION_ITEMS);
    const maxTextBytes = boundedPositive(request.limits?.maxTextBytes, DEFAULT_MAX_TEXT_BYTES, MAX_OBSERVATION_TEXT_BYTES);
    const data: BoundedSemanticNode[] = [];
    let textBytes = 0, truncated = nodes.length > maxItems;
    for (const node of nodes.slice(0, maxItems)) {
      if (!identity.frameTokens[node.frameId]) throw new Error('browser.frame.identity-unavailable');
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
    const errors = validateComputerObservationRequest(request, this.descriptor);
    if (errors.length) throw new Error(`invalid computer observation request: ${errors.join('; ')}`);
    if (request.target && request.channel !== 'semantic-ui') throw new Error('browser.observation.target-unsupported');
    if (request.target && (request.target.kind !== 'ui-control' || !request.target.surfaceId || request.target.generation === undefined)) throw new Error('browser.observation.target-invalid');
    const requestedSurface = this.observationTargetSurface(request) ?? request.surface;
    const surfaceCheck = this.validateSurface(requestedSurface);
    if (!surfaceCheck.ok) throw new Error(surfaceCheck.code);
    const surface = requestedSurface ?? this.currentSurface();
    const sequence = ++this.sequence;

    if (request.channel === 'semantic-ui') {
      if (!surface || this.runtime.activePageTargetId?.() !== surface.surfaceId) throw new Error('browser.surface.not-active');
      let nodes: InteractionNode[], identity: BrowserDocumentIdentity;
      if (request.target) {
        const resolved = await this.resolveEntity(request.target);
        if (!resolved) throw new Error('browser.observation.target-stale');
        nodes = [resolved.node];
        identity = resolved.identity;
      } else {
        const before = await this.activeDocumentIdentity(surface);
        if (!before) throw new Error('browser.document.identity-unavailable');
        nodes = await this.runtime.refresh();
        const after = await this.activeDocumentIdentity(surface);
        if (!after || !sameDocumentIdentity(before, after)) throw new Error('browser.document.identity-changed');
        identity = after;
      }
      const bounded = this.boundSemantic(nodes, surface, identity, request);
      return { adapterId: this.descriptor.id, environment: 'browser', channel: request.channel, sequence, complete: !bounded.truncated, truncated: bounded.truncated, surface, ...(request.target ? { target: request.target } : {}), data: bounded.data };
    }
    if (request.channel === 'document') {
      const maxBlocks = boundedPositive(request.limits?.maxItems, DEFAULT_MAX_ITEMS, MAX_OBSERVATION_ITEMS);
      const maxTextBytes = boundedPositive(request.limits?.maxTextBytes, DEFAULT_MAX_TEXT_BYTES, MAX_OBSERVATION_TEXT_BYTES);
      const maxDepth = boundedPositive(request.limits?.maxDepth, MAX_OBSERVATION_DEPTH, MAX_OBSERVATION_DEPTH);
      let snapshot: DocumentContentSnapshot | undefined;
      if (surface?.surfaceId && this.runtime.documentContentForPage) snapshot = await this.runtime.documentContentForPage(surface.surfaceId, { maxBlocks, maxTextBytes, maxDepth });
      else snapshot = await this.runtime.documentContent?.({ maxBlocks, maxTextBytes, maxDepth });
      if (!snapshot) throw new Error('browser.document.unsupported');
      return { adapterId: this.descriptor.id, environment: 'browser', channel: request.channel, sequence, complete: !snapshot.truncated && snapshot.frameErrors.length === 0, truncated: snapshot.truncated, ...(surface ? { surface } : {}), data: snapshot };
    }
    if (request.channel === 'visual') {
      if (!this.runtime.visualSnapshot) throw new Error('browser.visual.unsupported');
      const maxBytes = Math.min(request.limits?.maxTextBytes ?? DEFAULT_VISUAL_MAX_BYTES, DEFAULT_VISUAL_MAX_BYTES);
      const snapshot = await this.runtime.visualSnapshot(surface?.surfaceId, { maxBytes });
      if (!snapshot) throw new Error('browser.visual.unavailable');
      return { adapterId: this.descriptor.id, environment: 'browser', channel: request.channel, sequence, complete: true, truncated: false, ...(surface ? { surface } : {}), data: snapshot };
    }
    if (request.channel === 'media') {
      if (!this.runtime.mediaSnapshot) throw new Error('browser.media.unsupported');
      const snapshot = await this.runtime.mediaSnapshot(surface?.surfaceId, {
        maxMediaElements: boundedPositive(request.limits?.maxItems, 32, MAX_MEDIA_ELEMENTS),
        maxFrames: boundedPositive(request.limits?.maxDepth, 16, MAX_OBSERVATION_DEPTH),
        maxTextLength: boundedPositive(request.limits?.maxTextBytes, 256, MAX_MEDIA_TEXT_LENGTH),
      });
      if (!snapshot) throw new Error('browser.media.unavailable');
      return { adapterId: this.descriptor.id, environment: 'browser', channel: request.channel, sequence, complete: !snapshot.truncated && snapshot.errors.length === 0, truncated: snapshot.truncated, ...(surface ? { surface } : {}), data: snapshot };
    }
    throw new Error(`browser observation channel unsupported: ${request.channel}`);
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
        if (property === 'activate') {
          return async (...args: Parameters<TaskRuntimeEngine['activate']>) => {
            if (!(await adapter.entityIdentityCurrent(resolved))) {
              onStaleBeforeDispatch();
              return { status: 'target-not-found', target: null };
            }
            return target.activate(...args);
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
      ? { id: 'act' as const, kind: 'activate' as const, target: { backendNodeId: resolved!.node.backendNodeId, frameId: resolved!.node.frameId }, method: (payload as BrowserActivatePayload).method, key: (payload as BrowserActivatePayload).key, risk, next: 'done' as const }
      : { id: 'act' as const, kind: 'press-key' as const, key: (payload as BrowserPressKeyPayload).key, risk, next: 'done' as const };
    const result = await runtime.run({ version: 1, name: `computer-adapter:${request.actionId}`, entry: 'act', steps: [action, { id: 'done', kind: 'complete' }] }, {}, {
      ...this.options.runtimeOptions, maxSteps: 2, maxVisitsPerStep: 1, commitmentDetection: 'auto', commitmentVerification: 'auto',
    });
    if (staleBeforeDispatch) return failedPreDispatch('browser.target.stale-before-dispatch');
    return this.taskResult(result);
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    const errors = validateComputerActionRequest(request, this.descriptor);
    if (errors.length) return failedPreDispatch('browser.request.invalid');
    const authority: ComputerActionRequest = {
      adapterId: request.adapterId,
      actionId: request.actionId,
      capability: request.capability,
      effect: request.effect,
      idempotency: request.idempotency,
      ...(request.target ? { target: { ...request.target } } : {}),
      ...(request.payload !== undefined ? { payload: request.payload } : {}),
    };
    if (!this.descriptor.capabilities.includes(authority.capability)) return failedPreDispatch('browser.capability.unsupported', 'unsupported');
    if (authority.capability.endsWith('.observe')) return authority.effect === 'observe-only' && authority.idempotency === 'read-only'
      ? { status: 'completed', dispatch: 'not-dispatched', verification: 'verified', evidence: ['browser.verified-noop'] }
      : failedPreDispatch('browser.effect.invalid');
    if (authority.effect === 'observe-only' || authority.idempotency === 'read-only') return failedPreDispatch('browser.effect.invalid');

    if (authority.capability === 'browser.activate') {
      const payload = validateActivatePayload(authority.payload);
      if (!payload) return failedPreDispatch('browser.payload.invalid');
      const resolved = await this.resolveEntity(authority.target);
      if (!resolved) return failedPreDispatch('browser.target.stale');
      if (resolved.node.backendNodeId === undefined) return failedPreDispatch('browser.target.identity-unavailable');
      try { return await this.runCommitmentAwareAction(authority, payload, resolved); } catch { return unknownAfterInvocation('browser.dispatch.unknown'); }
    }
    if (authority.capability === 'browser.press-key') {
      if (authority.target) return failedPreDispatch('browser.target.unexpected');
      const payload = validatePressKeyPayload(authority.payload);
      if (!payload) return failedPreDispatch('browser.payload.invalid');
      try { return await this.runCommitmentAwareAction(authority, payload); } catch { return unknownAfterInvocation('browser.dispatch.unknown'); }
    }
    if (authority.effect !== 'local-reversible') return failedPreDispatch('browser.effect.unsupported');

    let invoked = false;
    try {
      if (authority.capability === 'browser.hover') {
        const resolved = await this.resolveEntity(authority.target);
        if (!resolved || !(await this.entityIdentityCurrent(resolved))) return failedPreDispatch('browser.target.stale');
        invoked = true;
        const result = await this.runtime.hover?.({ backendNodeId: resolved.node.backendNodeId, frameId: resolved.node.frameId }, { requireUnambiguous: true, autoReveal: true });
        if (!result) return unknownAfterInvocation('browser.hover.unsupported-after-invocation');
        return result.status === 'verified' ? { status: 'completed', dispatch: 'dispatched-once', verification: 'verified', evidence: ['browser.native-input'] } : { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: boundedEvidence([`browser.action.${result.status}`]) };
      }
      if (authority.capability === 'browser.type') {
        const payload = validateTypePayload(authority.payload);
        if (!payload) return failedPreDispatch('browser.payload.invalid');
        const resolved = await this.resolveEntity(authority.target);
        if (!resolved || !(await this.entityIdentityCurrent(resolved))) return failedPreDispatch('browser.target.stale');
        invoked = true;
        const result = await this.runtime.typeInto({ backendNodeId: resolved.node.backendNodeId, frameId: resolved.node.frameId }, payload.text, { requireUnambiguous: true, autoReveal: true, delayMs: payload.delayMs, expectedValue: payload.expectedValue });
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
