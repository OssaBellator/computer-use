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

function validReasonCode(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && REASON_CODE_PATTERN.test(value));
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

function captureKnownDataObject(value: unknown, allowed: readonly string[]): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (keys.some((key) => typeof key === 'symbol')) return undefined;
    const captured: Record<string, unknown> = Object.create(null);
    for (const key of keys as string[]) {
      const descriptor = descriptors[key];
      if (!descriptor || !('value' in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) return undefined;
      if (allowed.includes(key)) captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return undefined;
  }
}

function captureArrayLength(value: unknown, maxLength: number): number | undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
    if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'number' ||
        !Number.isSafeInteger(descriptor.value) || descriptor.value < 0 || descriptor.value > maxLength) return undefined;
    return descriptor.value;
  } catch {
    return undefined;
  }
}

function captureArrayElement(value: unknown, index: number): {ok:true;value:unknown} | {ok:false} {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value as object, String(index));
    if (!descriptor || !('value' in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) return {ok:false};
    return {ok:true,value:descriptor.value};
  } catch {
    return {ok:false};
  }
}

function capturePlainArray(value: unknown, maxLength: number): readonly unknown[] | undefined {
  const length = captureArrayLength(value, maxLength);
  if (length === undefined) return undefined;
  try {
    const keys = Reflect.ownKeys(value as object);
    if (keys.some((key) => typeof key === 'symbol')) return undefined;
    for (const key of keys as string[]) {
      if (key === 'length') continue;
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= length) return undefined;
    }
    const captured: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const entry = captureArrayElement(value, index);
      if (!entry.ok) return undefined;
      captured.push(entry.value);
    }
    return Object.freeze(captured);
  } catch {
    return undefined;
  }
}

function cloneBounds(value: unknown): DesktopWindowSurface['bounds'] {
  if (value === undefined) return undefined;
  const raw = captureKnownDataObject(value, ['x','y','width','height']);
  if (!raw || !exactCapturedKeys(raw, ['x','y','width','height']) ||
      !boundedFinite(raw.x, MAX_RECT_MAGNITUDE) || !boundedFinite(raw.y, MAX_RECT_MAGNITUDE) ||
      !boundedFinite(raw.width, MAX_RECT_MAGNITUDE) || !boundedFinite(raw.height, MAX_RECT_MAGNITUDE) ||
      raw.width < 0 || raw.height < 0) throw new Error('desktop window bounds invalid');
  return Object.freeze({x:raw.x,y:raw.y,width:raw.width,height:raw.height});
}

function cloneAccessibilityBounds(value: unknown): DesktopControlEntity['bounds'] {
  if (value === undefined) return undefined;
  const raw = captureKnownDataObject(value, ['x','y','width','height']);
  if (!raw || !exactCapturedKeys(raw, ['x','y','width','height']) ||
      !boundedFinite(raw.x, MAX_RECT_MAGNITUDE) || !boundedFinite(raw.y, MAX_RECT_MAGNITUDE) ||
      !boundedFinite(raw.width, MAX_RECT_MAGNITUDE) || !boundedFinite(raw.height, MAX_RECT_MAGNITUDE) ||
      raw.width < 0 || raw.height < 0) throw new Error('desktop accessibility bounds invalid');
  return Object.freeze({x:raw.x,y:raw.y,width:raw.width,height:raw.height});
}

function cloneApplication(value: unknown): DesktopWindowSurface['application'] {
  if (value === undefined) return undefined;
  const raw = captureKnownDataObject(value, ['applicationId','processId']);
  if (!raw) throw new Error('desktop application identity invalid');
  if (raw.applicationId !== undefined && !validBoundedString(raw.applicationId, MAX_NATIVE_ID_BYTES)) throw new Error('desktop application identity invalid');
  if (raw.processId !== undefined && !validBoundedString(raw.processId, MAX_NATIVE_ID_BYTES)) throw new Error('desktop application identity invalid');
  return Object.freeze({
    ...(raw.applicationId !== undefined ? {applicationId:raw.applicationId} : {}),
    ...(raw.processId !== undefined ? {processId:raw.processId} : {}),
  });
}

function cloneVisualArtifact(value: unknown): DesktopVisualArtifactRef | undefined {
  if (value === undefined) return undefined;
  const raw = captureKnownDataObject(value, ['token','mediaType','byteLength']);
  if (!raw || !validBoundedString(raw.token, MAX_VISUAL_TOKEN_BYTES)) throw new Error('desktop visual artifact metadata invalid');
  if (raw.mediaType !== undefined && !validBoundedString(raw.mediaType, MAX_MEDIA_TYPE_BYTES)) throw new Error('desktop visual artifact metadata invalid');
  if (raw.byteLength !== undefined && (!Number.isSafeInteger(raw.byteLength) || (raw.byteLength as number) < 0)) throw new Error('desktop visual artifact metadata invalid');
  return Object.freeze({
    token:raw.token,
    ...(raw.mediaType !== undefined ? {mediaType:raw.mediaType} : {}),
    ...(raw.byteLength !== undefined ? {byteLength:raw.byteLength as number} : {}),
  });
}

function validVisualDimension(value: unknown): value is number | undefined {
  return value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_VISUAL_DIMENSION);
}

function captureNativeWindowRef(value: unknown): DesktopNativeWindowRef | undefined {
  const raw = captureKnownDataObject(value, ['nativeWindowId','generation']);
  if (!raw || !validBoundedString(raw.nativeWindowId, MAX_NATIVE_ID_BYTES) ||
      typeof raw.generation !== 'number' || !Number.isSafeInteger(raw.generation) || raw.generation < 0) return undefined;
  return Object.freeze({nativeWindowId:raw.nativeWindowId,generation:raw.generation});
}

type CapturedWindowSnapshot = {
  nativeWindowId:string; generation:number; application?:DesktopWindowSurface['application']; title?:string;
  bounds?:DesktopWindowSurface['bounds']; foreground:boolean; focused:boolean;
};

function captureWindowSnapshot(value: unknown): CapturedWindowSnapshot | undefined {
  const raw = captureKnownDataObject(value, ['nativeWindowId','generation','application','title','bounds','foreground','focused']);
  if (!raw || !validBoundedString(raw.nativeWindowId, MAX_NATIVE_ID_BYTES) ||
      typeof raw.generation !== 'number' || !Number.isSafeInteger(raw.generation) || raw.generation < 0 ||
      typeof raw.foreground !== 'boolean' || typeof raw.focused !== 'boolean') return undefined;
  if (raw.title !== undefined && !validBoundedString(raw.title, MAX_TITLE_BYTES, true)) return undefined;
  let application: DesktopWindowSurface['application'];
  let bounds: DesktopWindowSurface['bounds'];
  try {
    application = cloneApplication(raw.application);
    bounds = cloneBounds(raw.bounds);
  } catch { return undefined; }
  return Object.freeze({
    nativeWindowId:raw.nativeWindowId,
    generation:raw.generation,
    ...(application ? {application} : {}),
    ...(raw.title !== undefined ? {title:raw.title} : {}),
    ...(bounds ? {bounds} : {}),
    foreground:raw.foreground,
    focused:raw.focused,
  });
}

function captureSystemObservation(value: unknown, maxItems: number): DesktopSystemObservation | undefined {
  const raw = captureKnownDataObject(value, ['windows','truncated','foregroundWindow','focusedWindow','focusedControlId']);
  if (!raw || typeof raw.truncated !== 'boolean') return undefined;
  const windowsRaw = capturePlainArray(raw.windows, maxItems);
  if (!windowsRaw) return undefined;
  const windows: CapturedWindowSnapshot[] = [];
  for (const candidate of windowsRaw) {
    const window = captureWindowSnapshot(candidate);
    if (!window) return undefined;
    windows.push(window);
  }
  let foregroundWindow: DesktopNativeWindowRef | undefined;
  let focusedWindow: DesktopNativeWindowRef | undefined;
  if (raw.foregroundWindow !== undefined) {
    foregroundWindow = captureNativeWindowRef(raw.foregroundWindow);
    if (!foregroundWindow) return undefined;
  }
  if (raw.focusedWindow !== undefined) {
    focusedWindow = captureNativeWindowRef(raw.focusedWindow);
    if (!focusedWindow) return undefined;
  }
  if (raw.focusedControlId !== undefined && !validBoundedString(raw.focusedControlId, MAX_CONTROL_ID_BYTES)) return undefined;
  return Object.freeze({
    windows:Object.freeze(windows), truncated:raw.truncated,
    ...(foregroundWindow ? {foregroundWindow} : {}),
    ...(focusedWindow ? {focusedWindow} : {}),
    ...(raw.focusedControlId !== undefined ? {focusedControlId:raw.focusedControlId} : {}),
  });
}

function captureVisualObservation(value: unknown): {status:'available'|'unavailable'|'unsupported';window:DesktopNativeWindowRef;width?:unknown;height?:unknown;artifact?:unknown;reason?:unknown} | undefined {
  const raw = captureKnownDataObject(value, ['status','window','width','height','artifact','reason']);
  if (!raw || (raw.status !== 'available' && raw.status !== 'unavailable' && raw.status !== 'unsupported')) return undefined;
  const window = captureNativeWindowRef(raw.window);
  if (!window) return undefined;
  return Object.freeze({status:raw.status,window,
    ...(Object.hasOwn(raw,'width') ? {width:raw.width} : {}),
    ...(Object.hasOwn(raw,'height') ? {height:raw.height} : {}),
    ...(Object.hasOwn(raw,'artifact') ? {artifact:raw.artifact} : {}),
    ...(Object.hasOwn(raw,'reason') ? {reason:raw.reason} : {}),
  });
}

function captureAccessibilityObservation(value: unknown): {status:'available'|'unavailable'|'unsupported';window:DesktopNativeWindowRef;root?:unknown;reason?:unknown} | undefined {
  const raw = captureKnownDataObject(value, ['status','window','root','reason']);
  if (!raw || (raw.status !== 'available' && raw.status !== 'unavailable' && raw.status !== 'unsupported')) return undefined;
  const window = captureNativeWindowRef(raw.window);
  if (!window) return undefined;
  if (raw.root !== undefined && (!raw.root || typeof raw.root !== 'object' || Array.isArray(raw.root))) return undefined;
  return Object.freeze({status:raw.status,window,
    ...(Object.hasOwn(raw,'root') ? {root:raw.root} : {}),
    ...(Object.hasOwn(raw,'reason') ? {reason:raw.reason} : {}),
  });
}

type CapturedAccessibilityNode = {
  source:object; controlId:string; role?:string; name?:string; value?:string; enabled?:boolean; focused?:boolean;
  bounds?:DesktopControlEntity['bounds']; children?:unknown; childCount:number;
};

function captureAccessibilityNode(value: unknown): CapturedAccessibilityNode | undefined {
  const raw = captureKnownDataObject(value, ['controlId','role','name','value','enabled','focused','bounds','children']);
  if (!raw || !validBoundedString(raw.controlId, MAX_CONTROL_ID_BYTES)) return undefined;
  if (raw.role !== undefined && !validBoundedString(raw.role, MAX_ACCESSIBILITY_ROLE_BYTES, true)) return undefined;
  if (raw.name !== undefined && !validBoundedString(raw.name, MAX_ACCESSIBILITY_TEXT_BYTES, true)) return undefined;
  if (raw.value !== undefined && !validBoundedString(raw.value, MAX_ACCESSIBILITY_TEXT_BYTES, true)) return undefined;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return undefined;
  if (raw.focused !== undefined && typeof raw.focused !== 'boolean') return undefined;
  let bounds: DesktopControlEntity['bounds'];
  try { bounds = cloneAccessibilityBounds(raw.bounds); } catch { return undefined; }
  let childCount = 0;
  if (raw.children !== undefined) {
    const length = captureArrayLength(raw.children, Number.MAX_SAFE_INTEGER);
    if (length === undefined) return undefined;
    childCount = length;
  }
  return Object.freeze({
    source:value as object, controlId:raw.controlId,
    ...(raw.role !== undefined ? {role:raw.role} : {}),
    ...(raw.name !== undefined ? {name:raw.name} : {}),
    ...(raw.value !== undefined ? {value:raw.value} : {}),
    ...(raw.enabled !== undefined ? {enabled:raw.enabled} : {}),
    ...(raw.focused !== undefined ? {focused:raw.focused} : {}),
    ...(bounds ? {bounds} : {}),
    ...(raw.children !== undefined ? {children:raw.children} : {}), childCount,
  });
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

function captureBackendActionResult(value: unknown): DesktopBackendActionResult | undefined {
  const captured = captureOwnDataObject(value, ['status','dispatched','verified','evidence']);
  if (!captured) return undefined;
  const status = captured.status;
  const dispatched = captured.dispatched;
  const verified = captured.verified;
  if (status !== 'completed' && status !== 'rejected' && status !== 'unsupported' && status !== 'failed') return undefined;
  if (typeof dispatched !== 'boolean') return undefined;
  if (verified !== undefined && typeof verified !== 'boolean') return undefined;
  let evidence: readonly string[] | undefined;
  if (captured.evidence !== undefined) {
    const rawEvidence = capturePlainArray(captured.evidence, MAX_BACKEND_EVIDENCE);
    if (!rawEvidence) {
      if (!Array.isArray(captured.evidence)) return undefined;
      evidence = Object.freeze(['desktop-backend-evidence-invalid']);
    } else {
      evidence = sanitizeEvidence(rawEvidence as readonly string[]);
    }
  }
  return Object.freeze({
    status,
    dispatched,
    ...(verified !== undefined ? {verified} : {}),
    ...(evidence !== undefined ? {evidence} : {}),
  });
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

  private surface(window: CapturedWindowSnapshot): DesktopWindowSurface {
    return Object.freeze({
      surface: Object.freeze({ adapterId: this.descriptor.id, environment: 'desktop-ui', surfaceId: window.nativeWindowId, generation: window.generation }),
      nativeWindowId: window.nativeWindowId,
      generation: window.generation,
      ...(window.application ? {application:window.application} : {}),
      ...(window.title !== undefined ? {title:window.title} : {}),
      ...(window.bounds ? {bounds:window.bounds} : {}),
      foreground: window.foreground,
      focused: window.focused,
    });
  }

  private async system(l: Required<ComputerObservationLimits>): Promise<{ raw:DesktopSystemObservation; windows:DesktopWindowSurface[] }> {
    const backendRaw: unknown = await this.backend.observeSystem(l);
    const raw = captureSystemObservation(backendRaw, l.maxItems);
    if (!raw) throw new Error('desktop backend system observation invalid');
    return { raw, windows: raw.windows.map((window) => this.surface(window as CapturedWindowSnapshot)) };
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

  private boundTree(window: DesktopWindowSurface, root: unknown, l: Required<ComputerObservationLimits>): { root?:DesktopControlEntity; itemCount:number; textBytes:number; truncated:boolean } {
    let itemCount = 0;
    let bytes = 0;
    let truncated = false;
    const active = new Set<object>();
    const visit = (value: unknown, depth:number): DesktopControlEntity | undefined => {
      if (itemCount >= l.maxItems || depth > l.maxDepth) { truncated = true; return undefined; }
      const node = captureAccessibilityNode(value);
      if (!node) throw new Error('desktop accessibility node invalid');
      if (active.has(node.source)) throw new Error('desktop accessibility cycle invalid');
      const ownBytes = textBytes(node.controlId) + textBytes(node.role) + textBytes(node.name) + textBytes(node.value);
      if (bytes + ownBytes > l.maxTextBytes) { truncated = true; return undefined; }
      itemCount += 1;
      bytes += ownBytes;
      active.add(node.source);
      const children: DesktopControlEntity[] = [];
      try {
        if (node.childCount > 0 && (depth >= l.maxDepth || itemCount >= l.maxItems || bytes >= l.maxTextBytes)) {
          truncated = true;
        } else if (node.children !== undefined) {
          for (let index = 0; index < node.childCount; index += 1) {
            if (itemCount >= l.maxItems || bytes >= l.maxTextBytes) { truncated = true; break; }
            const entry = captureArrayElement(node.children, index);
            if (!entry.ok) throw new Error('desktop accessibility child invalid');
            const bounded = visit(entry.value, depth + 1);
            if (!bounded) {
              if (truncated) break;
              continue;
            }
            children.push(bounded);
          }
        }
      } finally {
        active.delete(node.source);
      }
      return Object.freeze({
        entity:this.controlRef(window,node.controlId),
        ...(node.role !== undefined ? {role:node.role} : {}),
        ...(node.name !== undefined ? {name:node.name} : {}),
        ...(node.value !== undefined ? {value:node.value} : {}),
        ...(node.enabled !== undefined ? {enabled:node.enabled} : {}),
        ...(node.focused !== undefined ? {focused:node.focused} : {}),
        ...(node.bounds ? {bounds:node.bounds} : {}),
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
      const raw = captureVisualObservation(await this.backend.observeVisual(ref));
      if (!raw) throw new Error('desktop visual observation invalid');
      if (raw.window.nativeWindowId !== ref.nativeWindowId || raw.window.generation !== ref.generation) throw new Error('desktop visual generation mismatch');
      if (!validVisualDimension(raw.width) || !validVisualDimension(raw.height)) throw new Error('desktop visual dimensions invalid');
      const artifact = cloneVisualArtifact(raw.artifact);
      if (!validReasonCode(raw.reason)) throw new Error('desktop visual reason code invalid');
      const data:DesktopVisualObservationData = Object.freeze({ status:raw.status, window, width:raw.width, height:raw.height, ...(artifact ? {artifact} : {}), reason:raw.reason });
      return { adapterId:this.descriptor.id, environment:'desktop-ui', channel:'visual', sequence:this.sequence++, complete:raw.status==='available', truncated:false, surface:window.surface, target:request.target, data };
    }
    const l = limits(request.limits);
    const raw = captureAccessibilityObservation(await this.backend.observeAccessibility(ref, l));
    if (!raw) throw new Error('desktop accessibility observation invalid');
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
    const raw = captureAccessibilityObservation(await this.backend.observeAccessibility({nativeWindowId:window.nativeWindowId,generation:window.generation}, DEFAULT_LIMITS));
    if (!raw) throw new Error('desktop accessibility observation invalid');
    if (raw.window.nativeWindowId !== window.nativeWindowId || raw.window.generation !== window.generation) return false;
    if (raw.status !== 'available' || !raw.root) return false;
    const queue: {value:unknown;depth:number}[] = [{value:raw.root,depth:0}];
    const seenNodes = new Set<object>();
    let seen = 0;
    let bytes = 0;
    let cursor = 0;
    while (cursor < queue.length && seen < DEFAULT_LIMITS.maxItems) {
      const {value,depth} = queue[cursor++]!;
      const node = captureAccessibilityNode(value);
      if (!node) throw new Error('desktop accessibility node invalid');
      if (seenNodes.has(node.source)) throw new Error('desktop accessibility cycle invalid');
      seenNodes.add(node.source);
      const ownBytes = textBytes(node.controlId) + textBytes(node.role) + textBytes(node.name) + textBytes(node.value);
      if (bytes + ownBytes > DEFAULT_LIMITS.maxTextBytes) return false;
      bytes += ownBytes;
      seen += 1;
      if (node.controlId === target.entityId) return true;
      if (depth >= DEFAULT_LIMITS.maxDepth || seen >= DEFAULT_LIMITS.maxItems || bytes >= DEFAULT_LIMITS.maxTextBytes || node.children === undefined) continue;
      const remainingSlots = DEFAULT_LIMITS.maxItems - seen - (queue.length - cursor);
      const childLimit = Math.min(node.childCount, Math.max(0, remainingSlots));
      for (let index = 0; index < childLimit; index += 1) {
        const entry = captureArrayElement(node.children, index);
        if (!entry.ok) throw new Error('desktop accessibility child invalid');
        queue.push({value:entry.value,depth:depth + 1});
      }
    }
    return false;
  }

  private map(result:unknown, effect:ComputerActionRequest['effect']):ComputerActionResult {
    const captured = captureBackendActionResult(result);
    if (!captured) return {status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['desktop-backend-result-invalid']};
    const nativeVerification = effect === 'local-reversible' && captured.status === 'completed' && captured.verified === true;
    return {
      status:captured.status,
      dispatch:captured.dispatched?'dispatched-once':'not-dispatched',
      // Backend verification can prove low-level delivery for local-reversible input only.
      // Higher-risk effects require a separate domain verifier.
      verification:captured.status==='completed'?(nativeVerification?'verified':'not-applicable'):'unverified',
      evidence:captured.evidence,
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
