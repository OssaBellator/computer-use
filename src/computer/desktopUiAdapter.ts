import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEntityRef,
  ComputerEnvironmentAdapter,
  ComputerEnvironmentAdapterDescriptor,
  ComputerObservationEnvelope,
  ComputerObservationLimits,
  ComputerObservationRequest,
  ComputerSurfaceRef,
} from './environmentAdapter.js';
import type {
  DesktopAccessibilityNode,
  DesktopAccessibilityObservation,
  DesktopBackendActionResult,
  DesktopNativeWindowRef,
  DesktopSystemObservation,
  NativeDesktopUiBackend,
} from './desktopUiBackend.js';

const DEFAULT_LIMITS: Required<ComputerObservationLimits> = { maxItems: 256, maxTextBytes: 16_384, maxDepth: 16 };
const MAX_LIMIT = 10_000;

export interface DesktopWindowSurface {
  surface: ComputerSurfaceRef;
  nativeWindowId: string;
  generation: number;
  application?: { applicationId?: string; processId?: string };
  title?: string;
  bounds?: { x:number; y:number; width:number; height:number };
  foreground: boolean;
  focused: boolean;
}

export interface DesktopControlEntity {
  entity: ComputerEntityRef;
  role?: string;
  name?: string;
  value?: string;
  enabled?: boolean;
  focused?: boolean;
  bounds?: { x:number; y:number; width:number; height:number };
  children: readonly DesktopControlEntity[];
}

export interface DesktopSemanticObservationData {
  status: 'available' | 'unavailable' | 'unsupported';
  window: DesktopWindowSurface;
  root?: DesktopControlEntity;
  itemCount: number;
  textBytes: number;
  reason?: string;
}

export interface DesktopVisualObservationData {
  status: 'available' | 'unavailable' | 'unsupported';
  window: DesktopWindowSurface;
  width?: number;
  height?: number;
  artifact?: unknown;
  reason?: string;
}

export interface DesktopSystemObservationData {
  windows: readonly DesktopWindowSurface[];
  foregroundSurface?: ComputerSurfaceRef;
  focusedSurface?: ComputerSurfaceRef;
  focusedControl?: ComputerEntityRef;
}

function limits(input?: ComputerObservationLimits): Required<ComputerObservationLimits> {
  return {
    maxItems: Math.min(MAX_LIMIT, input?.maxItems ?? DEFAULT_LIMITS.maxItems),
    maxTextBytes: Math.min(1_000_000, input?.maxTextBytes ?? DEFAULT_LIMITS.maxTextBytes),
    maxDepth: Math.min(128, input?.maxDepth ?? DEFAULT_LIMITS.maxDepth),
  };
}

function textBytes(value: string | undefined): number {
  return value ? new TextEncoder().encode(value).byteLength : 0;
}

function validFiniteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }

export class DesktopUiEnvironmentAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor;
  private sequence = 0;

  constructor(readonly backend: NativeDesktopUiBackend, adapterId = `desktop-ui:${backend.id}`) {
    const capabilities = [
      'desktop.observe.semantic-ui',
      'desktop.observe.system',
      'desktop.observe.visual',
      'desktop.focus',
      'desktop.keyboard',
      'desktop.pointer.absolute',
    ];
    if (backend.supportsRelativePointer && backend.pointerRelative) capabilities.push('desktop.pointer.relative');
    this.descriptor = Object.freeze({ id: adapterId, kind: 'desktop-ui', version: '0.1', capabilities: Object.freeze(capabilities) });
  }

  private surface(window: { nativeWindowId:string; generation:number; application?:{applicationId?:string;processId?:string}; title?:string; bounds?:{x:number;y:number;width:number;height:number}; foreground:boolean; focused:boolean }): DesktopWindowSurface {
    return {
      surface: { adapterId: this.descriptor.id, environment: 'desktop-ui', surfaceId: window.nativeWindowId, generation: window.generation },
      nativeWindowId: window.nativeWindowId,
      generation: window.generation,
      application: window.application,
      title: window.title,
      bounds: window.bounds,
      foreground: window.foreground,
      focused: window.focused,
    };
  }

  private async system(): Promise<{ raw:DesktopSystemObservation; windows:DesktopWindowSurface[] }> {
    const raw = await this.backend.observeSystem();
    return { raw, windows: raw.windows.map((window) => this.surface(window)) };
  }

  private requestedWindow(request: ComputerObservationRequest | ComputerActionRequest): DesktopNativeWindowRef | undefined {
    const source = 'surface' in request ? request.surface : undefined;
    const target = request.target;
    const surfaceId = source?.surfaceId ?? (target?.kind === 'surface' ? target.entityId : target?.surfaceId);
    const generation = source?.generation ?? target?.generation;
    if (!surfaceId || generation === undefined) return undefined;
    return { nativeWindowId: surfaceId, generation };
  }

  private async currentWindow(ref: DesktopNativeWindowRef): Promise<DesktopWindowSurface | undefined> {
    const { windows } = await this.system();
    return windows.find((window) => window.nativeWindowId === ref.nativeWindowId && window.generation === ref.generation);
  }

  private controlRef(window: DesktopWindowSurface, controlId: string): ComputerEntityRef {
    return { adapterId:this.descriptor.id, environment:'desktop-ui', kind:'ui-control', entityId:controlId, surfaceId:window.nativeWindowId, generation:window.generation };
  }

  private boundTree(window: DesktopWindowSurface, root: DesktopAccessibilityNode, l: Required<ComputerObservationLimits>): { root?:DesktopControlEntity; itemCount:number; textBytes:number; truncated:boolean } {
    let itemCount = 0;
    let bytes = 0;
    let truncated = false;
    const visit = (node:DesktopAccessibilityNode, depth:number): DesktopControlEntity | undefined => {
      if (itemCount >= l.maxItems || depth > l.maxDepth) { truncated = true; return undefined; }
      const ownBytes = textBytes(node.role) + textBytes(node.name) + textBytes(node.value);
      if (bytes + ownBytes > l.maxTextBytes) { truncated = true; return undefined; }
      itemCount += 1; bytes += ownBytes;
      const children: DesktopControlEntity[] = [];
      for (const child of node.children ?? []) {
        const bounded = visit(child, depth + 1);
        if (bounded) children.push(bounded);
        if (truncated && itemCount >= l.maxItems) break;
      }
      return { entity:this.controlRef(window,node.controlId), role:node.role, name:node.name, value:node.value, enabled:node.enabled, focused:node.focused, bounds:node.bounds, children };
    };
    return { root: visit(root, 0), itemCount, textBytes:bytes, truncated };
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    if (request.adapterId !== this.descriptor.id) throw new Error('desktop adapter id mismatch');
    if (request.channel === 'system') {
      const { raw, windows } = await this.system();
      const byRef = (ref:DesktopNativeWindowRef|undefined) => ref ? windows.find((w) => w.nativeWindowId===ref.nativeWindowId && w.generation===ref.generation)?.surface : undefined;
      const focusedWindow = raw.focusedWindow ? windows.find((w)=>w.nativeWindowId===raw.focusedWindow!.nativeWindowId && w.generation===raw.focusedWindow!.generation) : undefined;
      const data:DesktopSystemObservationData = {
        windows,
        foregroundSurface: byRef(raw.foregroundWindow),
        focusedSurface: byRef(raw.focusedWindow),
        focusedControl: focusedWindow && raw.focusedControlId ? this.controlRef(focusedWindow, raw.focusedControlId) : undefined,
      };
      return { adapterId:this.descriptor.id, environment:'desktop-ui', channel:'system', sequence:this.sequence++, complete:true, truncated:false, data };
    }
    if (request.channel !== 'semantic-ui' && request.channel !== 'visual') throw new Error(`desktop observation channel unsupported: ${request.channel}`);
    const ref = this.requestedWindow(request);
    if (!ref) throw new Error('desktop surface generation is required');
    const window = await this.currentWindow(ref);
    if (!window) throw new Error('stale or missing desktop window');
    if (request.channel === 'visual') {
      const raw = await this.backend.observeVisual(ref);
      const data:DesktopVisualObservationData = { status:raw.status, window, width:raw.width, height:raw.height, artifact:raw.artifact, reason:raw.reason };
      return { adapterId:this.descriptor.id, environment:'desktop-ui', channel:'visual', sequence:this.sequence++, complete:raw.status==='available', truncated:false, surface:window.surface, data };
    }
    const l = limits(request.limits);
    const raw:DesktopAccessibilityObservation = await this.backend.observeAccessibility(ref, l);
    if (raw.status !== 'available' || !raw.root) {
      const data:DesktopSemanticObservationData = { status:raw.status, window, itemCount:0, textBytes:0, reason:raw.reason };
      return { adapterId:this.descriptor.id, environment:'desktop-ui', channel:'semantic-ui', sequence:this.sequence++, complete:raw.status !== 'available', truncated:false, surface:window.surface, data };
    }
    const bounded = this.boundTree(window, raw.root, l);
    const data:DesktopSemanticObservationData = { status:'available', window, root:bounded.root, itemCount:bounded.itemCount, textBytes:bounded.textBytes };
    return { adapterId:this.descriptor.id, environment:'desktop-ui', channel:'semantic-ui', sequence:this.sequence++, complete:!bounded.truncated, truncated:bounded.truncated, surface:window.surface, data };
  }

  private async controlExists(window:DesktopWindowSurface, target:ComputerEntityRef): Promise<boolean> {
    if (target.kind !== 'ui-control' || target.surfaceId !== window.nativeWindowId || target.generation !== window.generation) return false;
    const raw = await this.backend.observeAccessibility({nativeWindowId:window.nativeWindowId,generation:window.generation}, DEFAULT_LIMITS);
    if (raw.status !== 'available' || !raw.root) return false;
    const queue = [raw.root];
    let seen = 0;
    while (queue.length && seen < DEFAULT_LIMITS.maxItems) {
      const node = queue.shift()!; seen += 1;
      if (node.controlId === target.entityId) return true;
      queue.push(...(node.children ?? []));
    }
    return false;
  }

  private map(result:DesktopBackendActionResult):ComputerActionResult {
    return { status:result.status, dispatch:result.dispatched?'dispatched-once':'not-dispatched', verification:result.status==='completed' && result.verified?'verified':result.status==='completed'?'not-applicable':'unverified', evidence:result.evidence };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    if (request.adapterId !== this.descriptor.id) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['adapter-id-mismatch']};
    const ref = this.requestedWindow(request);
    if (!ref) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['surface-generation-required']};
    let window:DesktopWindowSurface|undefined;
    try { window = await this.currentWindow(ref); }
    catch { return {status:'failed',dispatch:'not-dispatched',verification:'unverified',evidence:['desktop-preflight-failed']}; }
    if (!window) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['stale-window']};
    if (request.target?.kind === 'ui-control') {
      let exists = false;
      try { exists = await this.controlExists(window, request.target); }
      catch { return {status:'failed',dispatch:'not-dispatched',verification:'unverified',evidence:['desktop-preflight-failed']}; }
      if (!exists) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['stale-control']};
    } else if (request.target?.kind !== 'surface') {
      return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['desktop-target-kind-invalid']};
    }
    try {
      switch (request.capability) {
        case 'desktop.focus': {
          return this.map(await this.backend.focus({window:ref,controlId:request.target.kind === 'ui-control' ? request.target.entityId : undefined}, request.effect));
        }
        case 'desktop.keyboard': {
          const p = request.payload as {kind?:unknown;key?:unknown;text?:unknown;modifiers?:unknown}|undefined;
          if (!p || !['key-down','key-up','text'].includes(String(p.kind))) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['invalid-keyboard-payload']};
          return this.map(await this.backend.keyboard(ref, p as never, request.effect));
        }
        case 'desktop.pointer.absolute': {
          const p = request.payload as {x?:unknown;y?:unknown;kind?:unknown}|undefined;
          if (!p || !validFiniteNumber(p.x) || !validFiniteNumber(p.y) || !['move','down','up','click'].includes(String(p.kind))) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['invalid-pointer-payload']};
          return this.map(await this.backend.pointerAbsolute(ref, p as never, request.effect));
        }
        case 'desktop.pointer.relative': {
          if (!this.backend.supportsRelativePointer || !this.backend.pointerRelative) return {status:'unsupported',dispatch:'not-dispatched',verification:'unverified',evidence:['relative-pointer-unsupported']};
          const p = request.payload as {dx?:unknown;dy?:unknown}|undefined;
          if (!p || !validFiniteNumber(p.dx) || !validFiniteNumber(p.dy)) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['invalid-pointer-payload']};
          return this.map(await this.backend.pointerRelative(ref, p as never, request.effect));
        }
        default: return {status:'unsupported',dispatch:'not-dispatched',verification:'unverified',evidence:['desktop-capability-unsupported']};
      }
    } catch {
      return {status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['desktop-backend-threw-after-invocation']};
    }
  }
}
