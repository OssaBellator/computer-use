import {
  validateComputerActionRequest,
  validateComputerObservationRequest,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEntityRef,
  type ComputerEnvironmentAdapter,
  type ComputerEnvironmentAdapterDescriptor,
  type ComputerObservationEnvelope,
  type ComputerObservationLimits,
  type ComputerObservationRequest,
  type ComputerSurfaceRef,
} from './environmentAdapter.js';
import type {
  DesktopAbsolutePointerInput,
  DesktopAccessibilityNode,
  DesktopAccessibilityObservation,
  DesktopBackendActionResult,
  DesktopKeyboardInput,
  DesktopNativeWindowRef,
  DesktopRelativePointerInput,
  DesktopSystemObservation,
  DesktopVisualArtifactRef,
  NativeDesktopUiBackend,
} from './desktopUiBackend.js';

const DEFAULT_LIMITS: Required<ComputerObservationLimits> = { maxItems: 256, maxTextBytes: 16_384, maxDepth: 16 };
const MAX_LIMIT = 10_000;
const MAX_KEY_BYTES = 128;
const MAX_TEXT_INPUT_BYTES = 4_096;
const MAX_VISUAL_TOKEN_BYTES = 256;
const MAX_MEDIA_TYPE_BYTES = 128;
const MAX_NATIVE_ID_BYTES = 256;
const MAX_TITLE_BYTES = 4_096;
const MAX_CONTROL_ID_BYTES = 256;
const MAX_ACCESSIBILITY_ROLE_BYTES = 256;
const MAX_ACCESSIBILITY_TEXT_BYTES = 4_096;
const MAX_RECT_MAGNITUDE = 1_000_000;
const MAX_VISUAL_DIMENSION = 100_000;
const MAX_BACKEND_EVIDENCE = 16;
const PREFLIGHT_LIMITS: Required<ComputerObservationLimits> = { maxItems: MAX_LIMIT, maxTextBytes: 1_000_000, maxDepth: 1 };
const MAX_ABSOLUTE_COORDINATE = 1_000_000;
const MAX_RELATIVE_DELTA = 100_000;
const KEY_MODIFIERS = new Set(['alt', 'control', 'meta', 'shift']);
const POINTER_BUTTONS = new Set(['left', 'middle', 'right']);
const REASON_CODE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

type DesktopKeyboardModifier = 'alt'|'control'|'meta'|'shift';
type DesktopPointerButton = 'left'|'middle'|'right';

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
  artifact?: DesktopVisualArtifactRef;
  reason?: string;
}

export interface DesktopSystemObservationData {
  windows: readonly DesktopWindowSurface[];
  itemCount: number;
  textBytes: number;
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

function validBoundedString(value: unknown, maxBytes: number, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && textBytes(value) <= maxBytes && !value.includes('\0');
}

function validReasonCode(value: string | undefined): boolean {
  return value === undefined || REASON_CODE_PATTERN.test(value);
}

function sanitizeEvidence(evidence: readonly string[] | undefined): readonly string[] | undefined {
  if (evidence === undefined) return undefined;
  if (!Array.isArray(evidence) || evidence.length > MAX_BACKEND_EVIDENCE || evidence.some((code) => !validReasonCode(code))) {
    return Object.freeze(['desktop-backend-evidence-invalid']);
  }
  return Object.freeze([...evidence]);
}

function boundedFinite(value: unknown, maxMagnitude: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maxMagnitude;
}

function cloneBounds(value: unknown): DesktopWindowSurface['bounds'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('desktop window bounds invalid');
  const raw = value as {x?:unknown;y?:unknown;width?:unknown;height?:unknown};
  if (!boundedFinite(raw.x, MAX_RECT_MAGNITUDE) || !boundedFinite(raw.y, MAX_RECT_MAGNITUDE) ||
      !boundedFinite(raw.width, MAX_RECT_MAGNITUDE) || !boundedFinite(raw.height, MAX_RECT_MAGNITUDE) ||
      raw.width < 0 || raw.height < 0) throw new Error('desktop window bounds invalid');
  return Object.freeze({x:raw.x,y:raw.y,width:raw.width,height:raw.height});
}

function cloneAccessibilityBounds(value: unknown): DesktopControlEntity['bounds'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('desktop accessibility bounds invalid');
  const raw = value as {x?:unknown;y?:unknown;width?:unknown;height?:unknown};
  if (!boundedFinite(raw.x, MAX_RECT_MAGNITUDE) || !boundedFinite(raw.y, MAX_RECT_MAGNITUDE) ||
      !boundedFinite(raw.width, MAX_RECT_MAGNITUDE) || !boundedFinite(raw.height, MAX_RECT_MAGNITUDE) ||
      raw.width < 0 || raw.height < 0) throw new Error('desktop accessibility bounds invalid');
  return Object.freeze({x:raw.x,y:raw.y,width:raw.width,height:raw.height});
}

function cloneApplication(value: unknown): DesktopWindowSurface['application'] {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object') throw new Error('desktop application identity invalid');
  const raw = value as {applicationId?:unknown;processId?:unknown};
  if (raw.applicationId !== undefined && !validBoundedString(raw.applicationId, MAX_NATIVE_ID_BYTES)) throw new Error('desktop application identity invalid');
  if (raw.processId !== undefined && !validBoundedString(raw.processId, MAX_NATIVE_ID_BYTES)) throw new Error('desktop application identity invalid');
  return Object.freeze({
    ...(raw.applicationId !== undefined ? {applicationId:raw.applicationId} : {}),
    ...(raw.processId !== undefined ? {processId:raw.processId} : {}),
  });
}

function cloneVisualArtifact(value: DesktopVisualArtifactRef | undefined): DesktopVisualArtifactRef | undefined {
  if (value === undefined) return undefined;
  if (!validVisualArtifact(value)) throw new Error('desktop visual artifact metadata invalid');
  return Object.freeze({
    token:value.token,
    ...(value.mediaType !== undefined ? {mediaType:value.mediaType} : {}),
    ...(value.byteLength !== undefined ? {byteLength:value.byteLength} : {}),
  });
}

function validVisualDimension(value: number | undefined): boolean {
  return value === undefined || (Number.isSafeInteger(value) && value > 0 && value <= MAX_VISUAL_DIMENSION);
}

function validVisualArtifact(value: DesktopVisualArtifactRef | undefined): boolean {
  if (value === undefined) return true;
  if (!validBoundedString(value.token, MAX_VISUAL_TOKEN_BYTES)) return false;
  if (value.mediaType !== undefined && !validBoundedString(value.mediaType, MAX_MEDIA_TYPE_BYTES)) return false;
  return value.byteLength === undefined || (Number.isSafeInteger(value.byteLength) && value.byteLength >= 0);
}

function captureOwnDataObject(value: unknown, allowed: readonly string[]): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === 'symbol')) return undefined;
    const captured: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      if (!allowed.includes(key)) return undefined;
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) return undefined;
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return undefined;
  }
}

function exactCapturedKeys(value: Readonly<Record<string, unknown>>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function capturePlainArray(value: unknown, maxLength: number): readonly unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === 'symbol')) return undefined;
    const lengthDescriptor = (descriptors as Record<string, PropertyDescriptor | undefined>)['length'];
    const lengthValue = lengthDescriptor && 'value' in lengthDescriptor ? lengthDescriptor.value : undefined;
    if (typeof lengthValue !== 'number' || !Number.isSafeInteger(lengthValue) || lengthValue < 0 || lengthValue > maxLength) return undefined;
    const length = lengthValue;
    const captured: unknown[] = [];
    for (const key of keys as string[]) {
      if (key === 'length') continue;
      if (!/^(0|[1-9][0-9]*)$/.test(key)) return undefined;
      const index = Number(key);
      if (index >= length) return undefined;
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) return undefined;
    }
    for (let index = 0; index < length; index += 1) {
      const descriptor = descriptors[String(index)];
      if (!descriptor || !('value' in descriptor)) return undefined;
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch {
    return undefined;
  }
}

function captureEntityRef(value: unknown): ComputerEntityRef | undefined {
  const captured = captureOwnDataObject(value, ['adapterId','environment','kind','entityId','surfaceId','generation']);
  if (!captured || typeof captured.adapterId !== 'string' || typeof captured.environment !== 'string' || typeof captured.kind !== 'string' || typeof captured.entityId !== 'string') return undefined;
  if (captured.surfaceId !== undefined && typeof captured.surfaceId !== 'string') return undefined;
  if (captured.generation !== undefined && typeof captured.generation !== 'number') return undefined;
  return Object.freeze({
    adapterId:captured.adapterId,
    environment:captured.environment as ComputerEntityRef['environment'],
    kind:captured.kind as ComputerEntityRef['kind'],
    entityId:captured.entityId,
    ...(captured.surfaceId !== undefined ? {surfaceId:captured.surfaceId} : {}),
    ...(captured.generation !== undefined ? {generation:captured.generation} : {}),
  });
}

function captureActionRequest(value: unknown): {request:ComputerActionRequest; payload:unknown} | undefined {
  const captured = captureOwnDataObject(value, ['adapterId','actionId','capability','effect','idempotency','target','payload']);
  if (!captured || typeof captured.adapterId !== 'string' || typeof captured.actionId !== 'string' || typeof captured.capability !== 'string' || typeof captured.effect !== 'string' || typeof captured.idempotency !== 'string') return undefined;
  let target: ComputerEntityRef | undefined;
  if (captured.target !== undefined) {
    target = captureEntityRef(captured.target);
    if (!target) return undefined;
  }
  const request = Object.freeze({
    adapterId:captured.adapterId,
    actionId:captured.actionId,
    capability:captured.capability,
    effect:captured.effect as ComputerActionRequest['effect'],
    idempotency:captured.idempotency as ComputerActionRequest['idempotency'],
    ...(target ? {target} : {}),
    ...(Object.hasOwn(captured, 'payload') ? {payload:captured.payload} : {}),
  });
  return {request, payload:captured.payload};
}

function validateKeyboardPayload(payload: unknown): DesktopKeyboardInput | undefined {
  const p = captureOwnDataObject(payload, ['kind', 'key', 'text', 'modifiers']);
  if (!p) return undefined;
  const kind = p.kind;
  if (kind === 'text') {
    const text = p.text;
    if (!exactCapturedKeys(p, ['kind', 'text']) || !validBoundedString(text, MAX_TEXT_INPUT_BYTES)) return undefined;
    return Object.freeze({ kind: 'text', text });
  }
  if (kind !== 'key-down' && kind !== 'key-up') return undefined;
  const key = p.key;
  if (!exactCapturedKeys(p, ['kind', 'key', 'modifiers']) || !validBoundedString(key, MAX_KEY_BYTES) || /[\r\n]/.test(key)) return undefined;
  if (p.modifiers === undefined) return Object.freeze({ kind, key });
  const modifiers = capturePlainArray(p.modifiers, KEY_MODIFIERS.size);
  if (!modifiers) return undefined;
  const seen = new Set<DesktopKeyboardModifier>();
  for (const modifier of modifiers) {
    if (typeof modifier !== 'string' || !KEY_MODIFIERS.has(modifier) || seen.has(modifier as DesktopKeyboardModifier)) return undefined;
    seen.add(modifier as DesktopKeyboardModifier);
  }
  return Object.freeze({ kind, key, modifiers: Object.freeze([...seen]) });
}

function boundedCoordinate(value: unknown, maxMagnitude: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= maxMagnitude;
}

function validateAbsolutePointerPayload(payload: unknown): DesktopAbsolutePointerInput | undefined {
  const p = captureOwnDataObject(payload, ['kind','x','y','button']);
  if (!p) return undefined;
  const kind = p.kind;
  const x = p.x;
  const y = p.y;
  const button = p.button;
  if (!boundedCoordinate(x, MAX_ABSOLUTE_COORDINATE) || !boundedCoordinate(y, MAX_ABSOLUTE_COORDINATE)) return undefined;
  if (kind === 'move') {
    if (!exactCapturedKeys(p, ['kind','x','y']) || button !== undefined) return undefined;
    return Object.freeze({ kind:'move', x, y });
  }
  if (kind !== 'down' && kind !== 'up' && kind !== 'click') return undefined;
  if (!exactCapturedKeys(p, ['kind','x','y','button']) || typeof button !== 'string' || !POINTER_BUTTONS.has(button)) return undefined;
  return Object.freeze({ kind, x, y, button:button as DesktopPointerButton });
}

function validateRelativePointerPayload(payload: unknown): DesktopRelativePointerInput | undefined {
  const p = captureOwnDataObject(payload, ['dx','dy']);
  if (!p || !exactCapturedKeys(p, ['dx','dy'])) return undefined;
  const dx = p.dx;
  const dy = p.dy;
  if (!boundedCoordinate(dx, MAX_RELATIVE_DELTA) || !boundedCoordinate(dy, MAX_RELATIVE_DELTA)) return undefined;
  return Object.freeze({ dx, dy });
}

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

  private surface(window: { nativeWindowId:string; generation:number; application?:unknown; title?:string; bounds?:unknown; foreground:boolean; focused:boolean }): DesktopWindowSurface {
    if (!validBoundedString(window.nativeWindowId, MAX_NATIVE_ID_BYTES) || !Number.isSafeInteger(window.generation) || window.generation < 0) throw new Error('desktop window identity invalid');
    if (window.title !== undefined && !validBoundedString(window.title, MAX_TITLE_BYTES, true)) throw new Error('desktop window title invalid');
    const application = cloneApplication(window.application);
    const bounds = cloneBounds(window.bounds);
    return Object.freeze({
      surface: Object.freeze({ adapterId: this.descriptor.id, environment: 'desktop-ui', surfaceId: window.nativeWindowId, generation: window.generation }),
      nativeWindowId: window.nativeWindowId,
      generation: window.generation,
      ...(application ? {application} : {}),
      ...(window.title !== undefined ? {title:window.title} : {}),
      ...(bounds ? {bounds} : {}),
      foreground: window.foreground === true,
      focused: window.focused === true,
    });
  }

  private async system(l: Required<ComputerObservationLimits>): Promise<{ raw:DesktopSystemObservation; windows:DesktopWindowSurface[] }> {
    const raw = await this.backend.observeSystem(l);
    if (raw.windows.length > l.maxItems) throw new Error('desktop backend exceeded system item limit');
    return { raw, windows: raw.windows.map((window) => this.surface(window)) };
  }

  private boundSystem(raw: DesktopSystemObservation, windows: DesktopWindowSurface[], l: Required<ComputerObservationLimits>): { data:DesktopSystemObservationData; truncated:boolean } {
    const bounded: DesktopWindowSurface[] = [];
    let bytes = 0;
    let truncated = raw.truncated;
    for (const window of windows) {
      if (bounded.length >= l.maxItems) { truncated = true; break; }
      const ownBytes = textBytes(window.nativeWindowId) + textBytes(window.title) + textBytes(window.application?.applicationId) + textBytes(window.application?.processId);
      if (bytes + ownBytes > l.maxTextBytes) { truncated = true; break; }
      bytes += ownBytes;
      bounded.push(window);
    }
    if (bounded.length < windows.length) truncated = true;
    const byRef = (ref:DesktopNativeWindowRef|undefined) => ref ? bounded.find((w) => w.nativeWindowId===ref.nativeWindowId && w.generation===ref.generation)?.surface : undefined;
    const focusedWindow = raw.focusedWindow ? bounded.find((w)=>w.nativeWindowId===raw.focusedWindow!.nativeWindowId && w.generation===raw.focusedWindow!.generation) : undefined;
    let focusedControl: ComputerEntityRef | undefined;
    if (focusedWindow && raw.focusedControlId) {
      const controlBytes = textBytes(raw.focusedControlId);
      if (bytes + controlBytes <= l.maxTextBytes) {
        bytes += controlBytes;
        focusedControl = this.controlRef(focusedWindow, raw.focusedControlId);
      } else truncated = true;
    }
    return { data:{ windows:bounded, itemCount:bounded.length, textBytes:bytes, foregroundSurface:byRef(raw.foregroundWindow), focusedSurface:byRef(raw.focusedWindow), focusedControl }, truncated };
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
    const { windows } = await this.system(PREFLIGHT_LIMITS);
    return windows.find((window) => window.nativeWindowId === ref.nativeWindowId && window.generation === ref.generation);
  }

  private controlRef(window: DesktopWindowSurface, controlId: string): ComputerEntityRef {
    return Object.freeze({ adapterId:this.descriptor.id, environment:'desktop-ui', kind:'ui-control', entityId:controlId, surfaceId:window.nativeWindowId, generation:window.generation });
  }

  private boundTree(window: DesktopWindowSurface, root: DesktopAccessibilityNode, l: Required<ComputerObservationLimits>): { root?:DesktopControlEntity; itemCount:number; textBytes:number; truncated:boolean } {
    let itemCount = 0;
    let bytes = 0;
    let truncated = false;
    const active = new Set<object>();
    const visit = (value: unknown, depth:number): DesktopControlEntity | undefined => {
      if (itemCount >= l.maxItems || depth > l.maxDepth) { truncated = true; return undefined; }
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('desktop accessibility node invalid');
      if (active.has(value)) throw new Error('desktop accessibility cycle invalid');
      const node = value as {controlId?:unknown;role?:unknown;name?:unknown;value?:unknown;enabled?:unknown;focused?:unknown;bounds?:unknown;children?:unknown};
      if (!validBoundedString(node.controlId, MAX_CONTROL_ID_BYTES)) throw new Error('desktop accessibility node invalid');
      if (node.role !== undefined && !validBoundedString(node.role, MAX_ACCESSIBILITY_ROLE_BYTES, true)) throw new Error('desktop accessibility node invalid');
      if (node.name !== undefined && !validBoundedString(node.name, MAX_ACCESSIBILITY_TEXT_BYTES, true)) throw new Error('desktop accessibility node invalid');
      if (node.value !== undefined && !validBoundedString(node.value, MAX_ACCESSIBILITY_TEXT_BYTES, true)) throw new Error('desktop accessibility node invalid');
      if (node.enabled !== undefined && typeof node.enabled !== 'boolean') throw new Error('desktop accessibility node invalid');
      if (node.focused !== undefined && typeof node.focused !== 'boolean') throw new Error('desktop accessibility node invalid');
      if (node.children !== undefined && !Array.isArray(node.children)) throw new Error('desktop accessibility node invalid');
      const bounds = cloneAccessibilityBounds(node.bounds);
      const ownBytes = textBytes(node.controlId) + textBytes(node.role as string|undefined) + textBytes(node.name as string|undefined) + textBytes(node.value as string|undefined);
      if (bytes + ownBytes > l.maxTextBytes) { truncated = true; return undefined; }
      itemCount += 1;
      bytes += ownBytes;
      active.add(value);
      const children: DesktopControlEntity[] = [];
      try {
        const rawChildren = node.children ?? [];
        if (rawChildren.length > 0 && (depth >= l.maxDepth || itemCount >= l.maxItems || bytes >= l.maxTextBytes)) {
          truncated = true;
        } else {
          for (let index = 0; index < rawChildren.length; index += 1) {
            if (itemCount >= l.maxItems || bytes >= l.maxTextBytes) { truncated = true; break; }
            const bounded = visit(rawChildren[index], depth + 1);
            if (!bounded) {
              if (truncated) break;
              continue;
            }
            children.push(bounded);
          }
        }
      } finally {
        active.delete(value);
      }
      return Object.freeze({
        entity:this.controlRef(window,node.controlId),
        ...(node.role !== undefined ? {role:node.role as string} : {}),
        ...(node.name !== undefined ? {name:node.name as string} : {}),
        ...(node.value !== undefined ? {value:node.value as string} : {}),
        ...(node.enabled !== undefined ? {enabled:node.enabled} : {}),
        ...(node.focused !== undefined ? {focused:node.focused} : {}),
        ...(bounds ? {bounds} : {}),
        children:Object.freeze(children),
      });
    };
    return { root: visit(root, 0), itemCount, textBytes:bytes, truncated };
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    const requestErrors = validateComputerObservationRequest(request, this.descriptor);
    if (requestErrors.length > 0) throw new Error(`invalid desktop observation request: ${requestErrors.join('; ')}`);
    if (request.channel === 'system') {
      const l = limits(request.limits);
      const { raw, windows } = await this.system(l);
      const bounded = this.boundSystem(raw, windows, l);
      return { adapterId:this.descriptor.id, environment:'desktop-ui', channel:'system', sequence:this.sequence++, complete:!bounded.truncated, truncated:bounded.truncated, data:bounded.data };
    }
    if (request.channel !== 'semantic-ui' && request.channel !== 'visual') throw new Error(`desktop observation channel unsupported: ${request.channel}`);
    const ref = this.requestedWindow(request);
    if (!ref) throw new Error('desktop surface generation is required');
    const window = await this.currentWindow(ref);
    if (!window) throw new Error('stale or missing desktop window');
    if (request.channel === 'visual') {
      const raw = await this.backend.observeVisual(ref);
      if (raw.window.nativeWindowId !== ref.nativeWindowId || raw.window.generation !== ref.generation) throw new Error('desktop visual generation mismatch');
      if (!validVisualDimension(raw.width) || !validVisualDimension(raw.height)) throw new Error('desktop visual dimensions invalid');
      const artifact = cloneVisualArtifact(raw.artifact);
      if (!validReasonCode(raw.reason)) throw new Error('desktop visual reason code invalid');
      const data:DesktopVisualObservationData = Object.freeze({ status:raw.status, window, width:raw.width, height:raw.height, ...(artifact ? {artifact} : {}), reason:raw.reason });
      return { adapterId:this.descriptor.id, environment:'desktop-ui', channel:'visual', sequence:this.sequence++, complete:raw.status==='available', truncated:false, surface:window.surface, target:request.target, data };
    }
    const l = limits(request.limits);
    const raw:DesktopAccessibilityObservation = await this.backend.observeAccessibility(ref, l);
    if (raw.window.nativeWindowId !== ref.nativeWindowId || raw.window.generation !== ref.generation) throw new Error('desktop accessibility generation mismatch');
    if (!validReasonCode(raw.reason)) throw new Error('desktop accessibility reason code invalid');
    if (raw.status !== 'available' || !raw.root) {
      const data:DesktopSemanticObservationData = Object.freeze({ status:raw.status, window, itemCount:0, textBytes:0, reason:raw.reason });
      return { adapterId:this.descriptor.id, environment:'desktop-ui', channel:'semantic-ui', sequence:this.sequence++, complete:raw.status !== 'available', truncated:false, surface:window.surface, target:request.target, data };
    }
    const bounded = this.boundTree(window, raw.root, l);
    const data:DesktopSemanticObservationData = Object.freeze({ status:'available', window, ...(bounded.root ? {root:bounded.root} : {}), itemCount:bounded.itemCount, textBytes:bounded.textBytes });
    return { adapterId:this.descriptor.id, environment:'desktop-ui', channel:'semantic-ui', sequence:this.sequence++, complete:!bounded.truncated, truncated:bounded.truncated, surface:window.surface, target:request.target, data };
  }

  private async controlExists(window:DesktopWindowSurface, target:ComputerEntityRef): Promise<boolean> {
    if (target.adapterId !== this.descriptor.id || target.environment !== 'desktop-ui' || target.kind !== 'ui-control' || target.surfaceId !== window.nativeWindowId || target.generation !== window.generation) return false;
    const raw = await this.backend.observeAccessibility({nativeWindowId:window.nativeWindowId,generation:window.generation}, DEFAULT_LIMITS);
    if (raw.window.nativeWindowId !== window.nativeWindowId || raw.window.generation !== window.generation) return false;
    if (raw.status !== 'available' || !raw.root) return false;
    const queue: {value:unknown;depth:number}[] = [{value:raw.root,depth:0}];
    const seenNodes = new Set<object>();
    let seen = 0;
    let bytes = 0;
    let cursor = 0;
    while (cursor < queue.length && seen < DEFAULT_LIMITS.maxItems) {
      const {value,depth} = queue[cursor++]!;
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('desktop accessibility node invalid');
      if (seenNodes.has(value)) throw new Error('desktop accessibility cycle invalid');
      seenNodes.add(value);
      const node = value as {controlId?:unknown;role?:unknown;name?:unknown;value?:unknown;children?:unknown};
      if (!validBoundedString(node.controlId, MAX_CONTROL_ID_BYTES)) throw new Error('desktop accessibility node invalid');
      if (node.role !== undefined && !validBoundedString(node.role, MAX_ACCESSIBILITY_ROLE_BYTES, true)) throw new Error('desktop accessibility node invalid');
      if (node.name !== undefined && !validBoundedString(node.name, MAX_ACCESSIBILITY_TEXT_BYTES, true)) throw new Error('desktop accessibility node invalid');
      if (node.value !== undefined && !validBoundedString(node.value, MAX_ACCESSIBILITY_TEXT_BYTES, true)) throw new Error('desktop accessibility node invalid');
      if (node.children !== undefined && !Array.isArray(node.children)) throw new Error('desktop accessibility node invalid');
      const ownBytes = textBytes(node.controlId) + textBytes(node.role as string|undefined) + textBytes(node.name as string|undefined) + textBytes(node.value as string|undefined);
      if (bytes + ownBytes > DEFAULT_LIMITS.maxTextBytes) return false;
      bytes += ownBytes;
      seen += 1;
      if (node.controlId === target.entityId) return true;
      if (depth >= DEFAULT_LIMITS.maxDepth || seen >= DEFAULT_LIMITS.maxItems || bytes >= DEFAULT_LIMITS.maxTextBytes) continue;
      const rawChildren = node.children ?? [];
      const remainingSlots = DEFAULT_LIMITS.maxItems - seen - (queue.length - cursor);
      const childLimit = Math.min(rawChildren.length, Math.max(0, remainingSlots));
      for (let index = 0; index < childLimit; index += 1) {
        queue.push({value:rawChildren[index],depth:depth + 1});
      }
    }
    return false;
  }

  private map(result:DesktopBackendActionResult, effect:ComputerActionRequest['effect']):ComputerActionResult {
    const nativeVerification = effect === 'local-reversible' && result.status === 'completed' && result.verified;
    return {
      status:result.status,
      dispatch:result.dispatched?'dispatched-once':'not-dispatched',
      verification:result.status==='completed'?(nativeVerification?'verified':'not-applicable'):'unverified',
      evidence:sanitizeEvidence(result.evidence),
    };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    const captured = captureActionRequest(request);
    if (!captured) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['invalid-action-request']};
    const snapshotRequest = captured.request;
    const requestErrors = validateComputerActionRequest(snapshotRequest, this.descriptor);
    if (requestErrors.length > 0) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['invalid-action-request']};

    const authority = Object.freeze({
      actionId:snapshotRequest.actionId,
      capability:snapshotRequest.capability,
      effect:snapshotRequest.effect,
      idempotency:snapshotRequest.idempotency,
      target:snapshotRequest.target,
    });
    if (authority.effect === 'observe-only') return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['desktop-input-effect-invalid']};

    let keyboardInput: DesktopKeyboardInput | undefined;
    let absoluteInput: DesktopAbsolutePointerInput | undefined;
    let relativeInput: DesktopRelativePointerInput | undefined;
    switch (authority.capability) {
      case 'desktop.focus':
        break;
      case 'desktop.keyboard':
        keyboardInput = validateKeyboardPayload(captured.payload);
        if (!keyboardInput) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['invalid-keyboard-payload']};
        break;
      case 'desktop.pointer.absolute':
        absoluteInput = validateAbsolutePointerPayload(captured.payload);
        if (!absoluteInput) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['invalid-pointer-payload']};
        break;
      case 'desktop.pointer.relative':
        if (!this.backend.supportsRelativePointer || !this.backend.pointerRelative) return {status:'unsupported',dispatch:'not-dispatched',verification:'unverified',evidence:['relative-pointer-unsupported']};
        relativeInput = validateRelativePointerPayload(captured.payload);
        if (!relativeInput) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['invalid-pointer-payload']};
        break;
      default:
        return {status:'unsupported',dispatch:'not-dispatched',verification:'unverified',evidence:['desktop-capability-unsupported']};
    }

    const surfaceId = authority.target?.kind === 'surface' ? authority.target.entityId : authority.target?.surfaceId;
    const generation = authority.target?.generation;
    if (!surfaceId || generation === undefined) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['surface-generation-required']};
    const ref:DesktopNativeWindowRef = Object.freeze({nativeWindowId:surfaceId,generation});

    let window:DesktopWindowSurface|undefined;
    try { window = await this.currentWindow(ref); }
    catch { return {status:'failed',dispatch:'not-dispatched',verification:'unverified',evidence:['desktop-preflight-failed']}; }
    if (!window) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['stale-window']};
    if (authority.target?.kind === 'ui-control') {
      let exists = false;
      try { exists = await this.controlExists(window, authority.target); }
      catch { return {status:'failed',dispatch:'not-dispatched',verification:'unverified',evidence:['desktop-preflight-failed']}; }
      if (!exists) return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['stale-control']};
    } else if (authority.target?.kind !== 'surface') {
      return {status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:['desktop-target-kind-invalid']};
    }

    try {
      switch (authority.capability) {
        case 'desktop.focus':
          return this.map(await this.backend.focus({window:ref,controlId:authority.target.kind === 'ui-control' ? authority.target.entityId : undefined}, authority.effect), authority.effect);
        case 'desktop.keyboard':
          return this.map(await this.backend.keyboard(ref, keyboardInput!, authority.effect), authority.effect);
        case 'desktop.pointer.absolute':
          return this.map(await this.backend.pointerAbsolute(ref, absoluteInput!, authority.effect), authority.effect);
        case 'desktop.pointer.relative':
          return this.map(await this.backend.pointerRelative!(ref, relativeInput!, authority.effect), authority.effect);
      }
    } catch {
      return {status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['desktop-backend-threw-after-invocation']};
    }
  }
}
