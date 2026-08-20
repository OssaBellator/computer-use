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
const DEFAULT_VISUAL_MAX_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE = 12;
const MAX_EVIDENCE_BYTES = 96;

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

export interface BrowserTypePayload {
  text: string;
  expectedValue?: string;
  delayMs?: number;
}

export interface BrowserPressKeyPayload {
  key: string;
}

export interface BrowserScrollPayload {
  deltaX?: number;
  deltaY?: number;
}

/** Browser-specific runtime hooks stay outside the neutral computer contracts. */
export interface BrowserComputerRuntime extends TaskRuntimeEngine {
  browserTargets?(): BrowserTargetState[];
  visualSnapshot?(targetId: string | undefined, options?: VisualCaptureOptions): Promise<VisualSnapshot | undefined>;
  mediaSnapshot?(targetId: string | undefined, options?: ObserveMediaStateOptions): Promise<MediaStateSnapshot | undefined>;
}

export interface BrowserComputerEnvironmentAdapterOptions {
  adapterId?: string;
  version?: string;
  /** Passed to the existing browser TaskRuntime commitment gate/verifier. */
  runtimeOptions?: Omit<TaskRuntimeOptions, 'maxSteps' | 'maxVisitsPerStep' | 'commitmentDetection' | 'commitmentVerification'>;
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

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value: string, remaining: number): { value: string; bytes: number; truncated: boolean } {
  if (remaining <= 0) return { value: '', bytes: 0, truncated: value.length > 0 };
  const size = utf8Bytes(value);
  if (size <= remaining) return { value, bytes: size, truncated: false };
  let result = '';
  let bytes = 0;
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
    case 'side-effect-declined': return 'rejected';
    case 'side-effect-mismatch': return 'mismatch';
    case 'side-effect-canceled': return 'rejected';
    case 'side-effect-unverified': return 'unverified';
    default: return 'unverified';
  }
}

export class BrowserComputerEnvironmentAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor;
  private sequence = 0;

  constructor(
    readonly runtime: BrowserComputerRuntime,
    readonly options: BrowserComputerEnvironmentAdapterOptions = {},
  ) {
    this.descriptor = {
      id: options.adapterId ?? 'browser-chromium',
      kind: 'browser',
      version: options.version ?? '0.43',
      capabilities: [
        'browser.semantic-ui.observe',
        'browser.document.observe',
        'browser.visual.observe',
        'browser.media.observe',
        'browser.activate',
        'browser.hover',
        'browser.type',
        'browser.press-key',
        'browser.scroll-viewport',
      ],
    };
  }

  private targetById(targetId: string): BrowserTargetState | undefined {
    const full = this.runtime.browserTargets?.();
    const exact = full?.find((candidate) => candidate.targetId === targetId);
    if (exact) return exact;
    const summary = this.runtime.targetState?.();
    for (const candidate of [summary?.latestPage, summary?.latestUnattachedPage]) {
      if (candidate?.targetId === targetId) return candidate;
    }
    return undefined;
  }

  surfaceForTarget(target: BrowserTargetState): ComputerSurfaceRef {
    return {
      adapterId: this.descriptor.id,
      environment: 'browser',
      surfaceId: target.targetId,
      generation: target.sequence,
      ...(target.openerId ? { parentSurfaceId: target.openerId } : {}),
    };
  }

  currentSurface(): ComputerSurfaceRef | undefined {
    const targetId = this.runtime.activePageTargetId?.();
    if (!targetId) return undefined;
    const target = this.targetById(targetId);
    return target ? this.surfaceForTarget(target) : undefined;
  }

  private validateSurface(surface: ComputerSurfaceRef | undefined): { ok: true; targetId?: string; generation?: number } | { ok: false; code: string } {
    if (!surface) {
      const current = this.currentSurface();
      return current ? { ok: true, targetId: current.surfaceId, generation: current.generation } : { ok: true };
    }
    if (surface.adapterId !== this.descriptor.id || surface.environment !== 'browser') return { ok: false, code: 'browser.surface.adapter-mismatch' };
    const target = this.targetById(surface.surfaceId);
    if (!target) return { ok: false, code: 'browser.surface.stale' };
    if (surface.generation !== target.sequence) return { ok: false, code: 'browser.surface.generation-mismatch' };
    return { ok: true, targetId: target.targetId, generation: target.sequence };
  }

  entityForNode(node: InteractionNode, surface = this.currentSurface()): ComputerEntityRef {
    const stableId = node.backendNodeId !== undefined ? `backend:${node.backendNodeId}` : node.id;
    return {
      adapterId: this.descriptor.id,
      environment: 'browser',
      kind: 'ui-control',
      entityId: `${node.frameId}:${stableId}`,
      ...(surface ? { surfaceId: surface.surfaceId, generation: surface.generation } : {}),
    };
  }

  private async resolveEntity(target: ComputerEntityRef | undefined): Promise<{ node: InteractionNode; surface?: ComputerSurfaceRef } | undefined> {
    if (!target || target.adapterId !== this.descriptor.id || target.environment !== 'browser' || target.kind !== 'ui-control') return undefined;
    let surface: ComputerSurfaceRef | undefined;
    if (target.surfaceId) {
      const browserTarget = this.targetById(target.surfaceId);
      if (!browserTarget || target.generation !== browserTarget.sequence) return undefined;
      if (this.runtime.activePageTargetId?.() !== target.surfaceId) return undefined;
      surface = this.surfaceForTarget(browserTarget);
    }
    const separator = target.entityId.indexOf(':');
    if (separator < 0) return undefined;
    const frameId = target.entityId.slice(0, separator);
    const id = target.entityId.slice(separator + 1);
    const nodes = await this.runtime.refresh();
    const backendMatch = /^backend:(\d+)$/.exec(id);
    const node = backendMatch
      ? nodes.find((candidate) => candidate.frameId === frameId && candidate.backendNodeId === Number(backendMatch[1]))
      : nodes.find((candidate) => candidate.frameId === frameId && (candidate.id === id || candidate.structuralId === id));
    return node ? { node, surface } : undefined;
  }

  private boundSemantic(nodes: readonly InteractionNode[], surface: ComputerSurfaceRef | undefined, request: ComputerObservationRequest): { data: BoundedSemanticNode[]; truncated: boolean } {
    const maxItems = request.limits?.maxItems ?? DEFAULT_MAX_ITEMS;
    const maxTextBytes = request.limits?.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
    const data: BoundedSemanticNode[] = [];
    let textBytes = 0;
    let truncated = nodes.length > maxItems;
    for (const node of nodes.slice(0, maxItems)) {
      const bounded: BoundedSemanticNode = {
        entity: this.entityForNode(node, surface),
        focused: node.focused,
        disabled: node.disabled,
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

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    const errors = validateComputerObservationRequest(request, this.descriptor);
    if (errors.length) throw new Error(`invalid computer observation request: ${errors.join('; ')}`);
    const surfaceCheck = this.validateSurface(request.surface);
    if (!surfaceCheck.ok) throw new Error(surfaceCheck.code);
    const surface = request.surface ?? this.currentSurface();
    const sequence = ++this.sequence;

    if (request.channel === 'semantic-ui') {
      if (surface?.surfaceId && this.runtime.activePageTargetId?.() !== surface.surfaceId) throw new Error('browser.surface.not-active');
      const nodes = await this.runtime.refresh();
      const bounded = this.boundSemantic(nodes, surface, request);
      return { adapterId: this.descriptor.id, environment: 'browser', channel: request.channel, sequence, complete: !bounded.truncated, truncated: bounded.truncated, ...(surface ? { surface } : {}), data: bounded.data };
    }

    if (request.channel === 'document') {
      const maxBlocks = request.limits?.maxItems ?? DEFAULT_MAX_ITEMS;
      const maxTextBytes = request.limits?.maxTextBytes ?? DEFAULT_MAX_TEXT_BYTES;
      const maxDepth = request.limits?.maxDepth;
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
      const snapshot = await this.runtime.mediaSnapshot(surface?.surfaceId, { maxMediaElements: request.limits?.maxItems ?? 32, maxFrames: request.limits?.maxDepth ?? 16, maxTextLength: Math.min(request.limits?.maxTextBytes ?? 256, 2048) });
      if (!snapshot) throw new Error('browser.media.unavailable');
      return { adapterId: this.descriptor.id, environment: 'browser', channel: request.channel, sequence, complete: !snapshot.truncated && snapshot.errors.length === 0, truncated: snapshot.truncated, ...(surface ? { surface } : {}), data: snapshot };
    }

    throw new Error(`browser observation channel unsupported: ${request.channel}`);
  }

  private taskResult(result: TaskRunResult): ComputerActionResult {
    const actionTrace = result.trace.find((entry) => entry.stepId === 'act');
    if (actionTrace?.outcome === 'policy-blocked') return failedPreDispatch('browser.commitment.policy-blocked');
    if (actionTrace?.outcome === 'exception') return unknownAfterInvocation('browser.dispatch.unknown');
    if (result.status === 'completed') {
      return {
        status: 'completed',
        dispatch: 'dispatched-once',
        verification: 'verified',
        evidence: boundedEvidence([
          'browser.native-input',
          ...(actionTrace?.commitmentKind ? ['browser.commitment.delegated', `browser.commitment.${actionTrace.commitmentKind}`] : []),
        ]),
      };
    }
    if (result.status.startsWith('side-effect-')) {
      return {
        status: result.status === 'side-effect-declined' || result.status === 'side-effect-canceled' ? 'rejected' : 'unknown',
        dispatch: 'dispatched-once',
        verification: verificationFromTaskStatus(result.status),
        evidence: boundedEvidence(['browser.commitment.delegated', `browser.${result.status}`]),
      };
    }
    if (actionTrace) return unknownAfterInvocation(`browser.runtime.${result.status}`);
    return failedPreDispatch(`browser.runtime.${result.status}`, 'failed');
  }

  private async runCommitmentAwareAction(request: ComputerActionRequest, node?: InteractionNode): Promise<ComputerActionResult> {
    const runtime = new TaskRuntime(this.runtime);
    const risk = request.effect === 'observe-only' || request.effect === 'local-reversible' ? 'interaction' : 'external-side-effect';
    const payload = request.payload as BrowserActivatePayload | BrowserPressKeyPayload | undefined;
    const action = request.capability === 'browser.activate'
      ? {
          id: 'act' as const,
          kind: 'activate' as const,
          target: { backendNodeId: node!.backendNodeId, frameId: node!.frameId },
          method: (payload as BrowserActivatePayload | undefined)?.method,
          key: (payload as BrowserActivatePayload | undefined)?.key,
          risk,
          next: 'done' as const,
        }
      : {
          id: 'act' as const,
          kind: 'press-key' as const,
          key: (payload as BrowserPressKeyPayload).key,
          risk,
          next: 'done' as const,
        };
    const result = await runtime.run({
      version: 1,
      name: `computer-adapter:${request.actionId}`,
      entry: 'act',
      steps: [action, { id: 'done', kind: 'complete' }],
    }, {}, {
      ...this.options.runtimeOptions,
      maxSteps: 2,
      maxVisitsPerStep: 1,
      commitmentDetection: 'auto',
      commitmentVerification: 'auto',
    });
    return this.taskResult(result);
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    const errors = validateComputerActionRequest(request, this.descriptor);
    if (errors.length) return failedPreDispatch('browser.request.invalid');
    if (!this.descriptor.capabilities.includes(request.capability)) return failedPreDispatch('browser.capability.unsupported', 'unsupported');
    const resolved = request.target ? await this.resolveEntity(request.target) : undefined;
    if (request.target && !resolved) return failedPreDispatch('browser.target.stale');
    const node = resolved?.node;

    if (request.capability === 'browser.activate') {
      if (!node || node.backendNodeId === undefined) return failedPreDispatch('browser.target.identity-unavailable');
      try { return await this.runCommitmentAwareAction(request, node); }
      catch { return unknownAfterInvocation('browser.dispatch.unknown'); }
    }

    if (request.capability === 'browser.press-key') {
      const payload = request.payload as BrowserPressKeyPayload | undefined;
      if (!payload || typeof payload.key !== 'string' || !payload.key.trim()) return failedPreDispatch('browser.payload.invalid');
      try { return await this.runCommitmentAwareAction(request); }
      catch { return unknownAfterInvocation('browser.dispatch.unknown'); }
    }

    let invoked = false;
    try {
      if (request.capability === 'browser.hover') {
        if (!node) return failedPreDispatch('browser.target.required');
        invoked = true;
        const result = await this.runtime.hover?.({ backendNodeId: node.backendNodeId, frameId: node.frameId }, { requireUnambiguous: true, autoReveal: true });
        if (!result) return unknownAfterInvocation('browser.hover.unsupported-after-invocation');
        return result.status === 'verified'
          ? { status: 'completed', dispatch: 'dispatched-once', verification: 'verified', evidence: ['browser.native-input'] }
          : { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: boundedEvidence([`browser.action.${result.status}`]) };
      }
      if (request.capability === 'browser.type') {
        if (!node) return failedPreDispatch('browser.target.required');
        const payload = request.payload as BrowserTypePayload | undefined;
        if (!payload || typeof payload.text !== 'string') return failedPreDispatch('browser.payload.invalid');
        invoked = true;
        const result = await this.runtime.typeInto({ backendNodeId: node.backendNodeId, frameId: node.frameId }, payload.text, { requireUnambiguous: true, autoReveal: true, delayMs: payload.delayMs, expectedValue: payload.expectedValue });
        return result.status === 'verified'
          ? { status: 'completed', dispatch: 'dispatched-once', verification: 'verified', evidence: ['browser.native-input'] }
          : { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: boundedEvidence([`browser.action.${result.status}`]) };
      }
      if (request.capability === 'browser.scroll-viewport') {
        const payload = (request.payload ?? {}) as BrowserScrollPayload;
        const deltaX = payload.deltaX ?? 0, deltaY = payload.deltaY ?? 0;
        if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || (deltaX === 0 && deltaY === 0)) return failedPreDispatch('browser.payload.invalid');
        invoked = true;
        const result = await this.runtime.scrollViewport?.({ x: deltaX, y: deltaY });
        if (!result) return unknownAfterInvocation('browser.scroll.unsupported-after-invocation');
        return result.status === 'verified'
          ? { status: 'completed', dispatch: 'dispatched-once', verification: 'verified', evidence: ['browser.native-input'] }
          : { status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: boundedEvidence([`browser.action.${result.status}`]) };
      }
      if (request.capability.endsWith('.observe')) {
        return { status: 'completed', dispatch: 'not-dispatched', verification: 'verified', evidence: ['browser.verified-noop'] };
      }
      return failedPreDispatch('browser.capability.unsupported', 'unsupported');
    } catch {
      return invoked ? unknownAfterInvocation('browser.dispatch.unknown') : failedPreDispatch('browser.action.failed');
    }
  }

  mayAutoRetry(request: ComputerActionRequest, result: ComputerActionResult): boolean {
    return computerActionMayAutoRetry(request, result);
  }
}
