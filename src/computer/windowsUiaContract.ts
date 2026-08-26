import type {
  ComputerActionResult,
  ComputerEffectClass,
  ComputerObservationLimits,
} from './environmentAdapter.js';
import type { DesktopBackendActionResult, DesktopRect } from './desktopUiBackend.js';

export const WINDOWS_UIA_PATTERNS = [
  'invoke',
  'value',
  'toggle',
  'selection-item',
  'expand-collapse',
  'scroll',
  'range-value',
  'window',
] as const;

export type WindowsUiaPattern = typeof WINDOWS_UIA_PATTERNS[number];

export interface WindowsProcessGeneration {
  /** OS PID is not durable by itself; startIdentity prevents PID-reuse confusion. */
  readonly processId: number;
  readonly startIdentity: string;
}

export interface WindowsUiaWindowRef {
  /** Opaque HWND representation; callers must not parse or synthesize it. */
  readonly hwnd: string;
  readonly desktopSessionId: string;
  readonly process: WindowsProcessGeneration;
  readonly generation: number;
}

export interface WindowsUiaControlRef {
  readonly window: WindowsUiaWindowRef;
  /** Opaque UIA RuntimeId comparison material. It may be reused over time. */
  readonly runtimeId: readonly number[];
  /** Locator hint only; not global or release-stable identity. */
  readonly automationId?: string;
  readonly controlType: string;
  readonly structuralPathHash?: string;
  readonly generation: number;
}

export interface WindowsUiaControlSnapshot {
  readonly ref: WindowsUiaControlRef;
  readonly name?: string;
  readonly value?: string;
  readonly enabled?: boolean;
  readonly offscreen?: boolean;
  readonly bounds?: DesktopRect;
  readonly patterns: readonly WindowsUiaPattern[];
}

export interface WindowsUiaCachedObservation {
  readonly window: WindowsUiaWindowRef;
  readonly root?: WindowsUiaControlSnapshot;
  readonly itemCount: number;
  readonly textBytes: number;
  readonly truncated: boolean;
  /** Provider-local invalidation epoch captured with this cache snapshot. */
  readonly invalidationEpoch: number;
  readonly capturedAtMs: number;
}

export type WindowsUiaSemanticAction =
  | { readonly kind: 'invoke' }
  | { readonly kind: 'set-value'; readonly value: string }
  | { readonly kind: 'toggle' }
  | { readonly kind: 'select' }
  | { readonly kind: 'expand-collapse'; readonly state: 'expanded' | 'collapsed' }
  | {
      readonly kind: 'scroll';
      readonly horizontal: 'large-decrement' | 'small-decrement' | 'no-amount' | 'large-increment' | 'small-increment';
      readonly vertical: 'large-decrement' | 'small-decrement' | 'no-amount' | 'large-increment' | 'small-increment';
    }
  | { readonly kind: 'set-range-value'; readonly value: number }
  | { readonly kind: 'window'; readonly operation: 'minimize' | 'maximize' | 'restore' | 'close' };

export type WindowsUiaRevalidation =
  | { readonly status: 'current'; readonly control: WindowsUiaControlSnapshot }
  | { readonly status: 'stale' | 'missing' | 'ambiguous' | 'inaccessible'; readonly evidence?: readonly string[] };

export interface WindowsUiaProvider {
  /**
   * The provider must apply limits while acquiring/caching the UIA tree, not only
   * truncate after materializing it. Cache snapshots are observations, not proof.
   */
  observeCached(
    window: WindowsUiaWindowRef,
    limits: Required<ComputerObservationLimits>,
  ): Promise<WindowsUiaCachedObservation>;

  /**
   * Re-resolve the exact window/control immediately before dispatch. Implementations
   * should use UIA element comparison plus process/window generation checks.
   */
  revalidateControl(ref: WindowsUiaControlRef): Promise<WindowsUiaRevalidation>;

  /**
   * Dispatch exactly one semantic UIA control-pattern action. The provider must not
   * silently fall back to SendInput or coordinates from this method.
   */
  performSemanticAction(
    ref: WindowsUiaControlRef,
    action: WindowsUiaSemanticAction,
    effect: ComputerEffectClass,
  ): Promise<DesktopBackendActionResult>;
}

const MAX_TEXT_BYTES = 1_000_000;
const MAX_ITEMS = 10_000;
const MAX_DEPTH = 128;
const MAX_RUNTIME_ID_PARTS = 64;
const MAX_ID_BYTES = 256;
const MAX_VALUE_BYTES = 16_384;
const MAX_EVIDENCE = 16;
const MAX_EVIDENCE_BYTES = 128;
const MAX_RECT_MAGNITUDE = 1_000_000;
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const EXPAND_STATES = new Set(['expanded','collapsed']);
const SCROLL_AMOUNTS = new Set(['large-decrement','small-decrement','no-amount','large-increment','small-increment']);
const WINDOW_OPERATIONS = new Set(['minimize','maximize','restore','close']);
const REVALIDATION_STATUSES = new Set(['current','stale','missing','ambiguous','inaccessible']);

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedString(value: unknown, maxBytes = MAX_ID_BYTES, allowEmpty = false): value is string {
  return typeof value === 'string' && (allowEmpty || value.length > 0) && !value.includes('\0') && utf8Bytes(value) <= maxBytes;
}

function validGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function boundedFinite(value:unknown,maxMagnitude=MAX_RECT_MAGNITUDE):value is number {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= maxMagnitude;
}

function captureOwnDataObject(value: unknown, allowed: readonly string[]): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const captured:Record<string,unknown> = Object.create(null);
    for (const key of allowed) {
      const descriptor = Object.getOwnPropertyDescriptor(value,key);
      if (descriptor === undefined) continue;
      if (!('value' in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) return undefined;
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return undefined;
  }
}

function capturePlainArray(value:unknown,maxLength:number):readonly unknown[]|undefined {
  if (!Array.isArray(value)) return undefined;
  try {
    if (Object.getPrototypeOf(value) !== Array.prototype) return undefined;
    const length = Object.getOwnPropertyDescriptor(value,'length');
    if (!length || !('value' in length) || !Number.isSafeInteger(length.value) || length.value < 0 || length.value > maxLength) return undefined;
    const captured:unknown[] = [];
    for (let index=0; index<length.value; index+=1) {
      const descriptor = Object.getOwnPropertyDescriptor(value,String(index));
      if (!descriptor || !('value' in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined || !descriptor.enumerable) return undefined;
      captured.push(descriptor.value);
    }
    return Object.freeze(captured);
  } catch {
    return undefined;
  }
}

function captureEvidence(value:unknown):readonly string[]|undefined {
  if (value === undefined) return undefined;
  const raw = capturePlainArray(value,MAX_EVIDENCE);
  if (!raw || raw.some((entry)=>!boundedString(entry,MAX_EVIDENCE_BYTES))) return undefined;
  return Object.freeze(raw as readonly string[]);
}

function captureProcess(value:unknown):WindowsProcessGeneration|undefined {
  const raw = captureOwnDataObject(value,['processId','startIdentity']);
  if (!raw || !Number.isSafeInteger(raw.processId) || (raw.processId as number) <= 0 || !boundedString(raw.startIdentity)) return undefined;
  return Object.freeze({processId:raw.processId as number,startIdentity:raw.startIdentity});
}

export function captureWindowsUiaWindowRef(value:unknown):WindowsUiaWindowRef|undefined {
  const raw = captureOwnDataObject(value,['hwnd','desktopSessionId','process','generation']);
  if (!raw || !boundedString(raw.hwnd) || !boundedString(raw.desktopSessionId) || !validGeneration(raw.generation)) return undefined;
  const process = captureProcess(raw.process);
  if (!process) return undefined;
  return Object.freeze({hwnd:raw.hwnd,desktopSessionId:raw.desktopSessionId,process,generation:raw.generation});
}

export function captureWindowsUiaControlRef(value:unknown):WindowsUiaControlRef|undefined {
  const raw = captureOwnDataObject(value,['window','runtimeId','automationId','controlType','structuralPathHash','generation']);
  if (!raw || !boundedString(raw.controlType) || !validGeneration(raw.generation)) return undefined;
  const window = captureWindowsUiaWindowRef(raw.window);
  const runtimeIdRaw = capturePlainArray(raw.runtimeId,MAX_RUNTIME_ID_PARTS);
  if (!window || !runtimeIdRaw || runtimeIdRaw.length === 0 || runtimeIdRaw.some((part)=>!Number.isSafeInteger(part))) return undefined;
  if (raw.automationId !== undefined && !boundedString(raw.automationId)) return undefined;
  if (raw.structuralPathHash !== undefined && (typeof raw.structuralPathHash !== 'string' || !TOKEN_PATTERN.test(raw.structuralPathHash))) return undefined;
  return Object.freeze({
    window,
    runtimeId:Object.freeze(runtimeIdRaw as readonly number[]),
    ...(raw.automationId !== undefined ? {automationId:raw.automationId as string} : {}),
    controlType:raw.controlType,
    ...(raw.structuralPathHash !== undefined ? {structuralPathHash:raw.structuralPathHash as string} : {}),
    generation:raw.generation,
  });
}

export function captureWindowsUiaSemanticAction(value:unknown):WindowsUiaSemanticAction|undefined {
  const raw = captureOwnDataObject(value,['kind','value','state','horizontal','vertical','operation']);
  if (!raw || typeof raw.kind !== 'string') return undefined;
  switch (raw.kind) {
    case 'invoke': return Object.freeze({kind:'invoke'});
    case 'toggle': return Object.freeze({kind:'toggle'});
    case 'select': return Object.freeze({kind:'select'});
    case 'set-value':
      return boundedString(raw.value,MAX_VALUE_BYTES) ? Object.freeze({kind:'set-value',value:raw.value}) : undefined;
    case 'set-range-value':
      return typeof raw.value === 'number' && Number.isFinite(raw.value) ? Object.freeze({kind:'set-range-value',value:raw.value}) : undefined;
    case 'expand-collapse':
      return typeof raw.state === 'string' && EXPAND_STATES.has(raw.state) ? Object.freeze({kind:'expand-collapse',state:raw.state as 'expanded'|'collapsed'}) : undefined;
    case 'scroll':
      return typeof raw.horizontal === 'string' && SCROLL_AMOUNTS.has(raw.horizontal) && typeof raw.vertical === 'string' && SCROLL_AMOUNTS.has(raw.vertical)
        ? Object.freeze({kind:'scroll',horizontal:raw.horizontal as WindowsUiaSemanticAction & never,vertical:raw.vertical as never}) as WindowsUiaSemanticAction
        : undefined;
    case 'window':
      return typeof raw.operation === 'string' && WINDOW_OPERATIONS.has(raw.operation)
        ? Object.freeze({kind:'window',operation:raw.operation as 'minimize'|'maximize'|'restore'|'close'})
        : undefined;
    default:return undefined;
  }
}

function captureBounds(value:unknown):DesktopRect|undefined {
  if (value === undefined) return undefined;
  const raw = captureOwnDataObject(value,['x','y','width','height']);
  if (!raw || !boundedFinite(raw.x) || !boundedFinite(raw.y) || !boundedFinite(raw.width) || !boundedFinite(raw.height) || raw.width < 0 || raw.height < 0) return undefined;
  return Object.freeze({x:raw.x,y:raw.y,width:raw.width,height:raw.height});
}

function captureControlSnapshot(value:unknown):WindowsUiaControlSnapshot|undefined {
  const raw = captureOwnDataObject(value,['ref','name','value','enabled','offscreen','bounds','patterns']);
  if (!raw) return undefined;
  const ref = captureWindowsUiaControlRef(raw.ref);
  const patternsRaw = capturePlainArray(raw.patterns,WINDOWS_UIA_PATTERNS.length);
  if (!ref || !patternsRaw || patternsRaw.some((pattern)=>typeof pattern !== 'string' || !WINDOWS_UIA_PATTERNS.includes(pattern as WindowsUiaPattern))) return undefined;
  if (raw.name !== undefined && !boundedString(raw.name,MAX_VALUE_BYTES,true)) return undefined;
  if (raw.value !== undefined && !boundedString(raw.value,MAX_VALUE_BYTES,true)) return undefined;
  if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') return undefined;
  if (raw.offscreen !== undefined && typeof raw.offscreen !== 'boolean') return undefined;
  const bounds = captureBounds(raw.bounds);
  if (raw.bounds !== undefined && !bounds) return undefined;
  return Object.freeze({
    ref,
    ...(raw.name !== undefined ? {name:raw.name as string} : {}),
    ...(raw.value !== undefined ? {value:raw.value as string} : {}),
    ...(raw.enabled !== undefined ? {enabled:raw.enabled as boolean} : {}),
    ...(raw.offscreen !== undefined ? {offscreen:raw.offscreen as boolean} : {}),
    ...(bounds ? {bounds} : {}),
    patterns:Object.freeze(patternsRaw as readonly WindowsUiaPattern[]),
  });
}

function captureRevalidation(value:unknown):WindowsUiaRevalidation|undefined {
  const raw = captureOwnDataObject(value,['status','control','evidence']);
  if (!raw || typeof raw.status !== 'string' || !REVALIDATION_STATUSES.has(raw.status)) return undefined;
  if (raw.status === 'current') {
    const control = captureControlSnapshot(raw.control);
    return control ? Object.freeze({status:'current',control}) : undefined;
  }
  const evidence = captureEvidence(raw.evidence);
  if (raw.evidence !== undefined && evidence === undefined) return undefined;
  return Object.freeze({status:raw.status as 'stale'|'missing'|'ambiguous'|'inaccessible',...(evidence ? {evidence} : {})});
}

function captureBackendResult(value:unknown):DesktopBackendActionResult|undefined {
  const raw = captureOwnDataObject(value,['status','dispatched','verified','evidence']);
  if (!raw || !['completed','rejected','unsupported','failed'].includes(raw.status as string) || typeof raw.dispatched !== 'boolean') return undefined;
  if (raw.verified !== undefined && typeof raw.verified !== 'boolean') return undefined;
  const evidence = captureEvidence(raw.evidence);
  if (raw.evidence !== undefined && evidence === undefined) return undefined;
  return Object.freeze({
    status:raw.status as DesktopBackendActionResult['status'],
    dispatched:raw.dispatched,
    ...(raw.verified !== undefined ? {verified:raw.verified as boolean} : {}),
    ...(evidence ? {evidence} : {}),
  });
}

function validProcess(value: WindowsProcessGeneration): boolean {
  return Number.isSafeInteger(value.processId) && value.processId > 0 && boundedString(value.startIdentity);
}

export function validateWindowsUiaWindowRef(ref: WindowsUiaWindowRef): boolean {
  return captureWindowsUiaWindowRef(ref) !== undefined;
}

export function validateWindowsUiaControlRef(ref: WindowsUiaControlRef): boolean {
  return captureWindowsUiaControlRef(ref) !== undefined;
}

export function sameWindowsUiaWindow(a: WindowsUiaWindowRef, b: WindowsUiaWindowRef): boolean {
  return a.hwnd === b.hwnd &&
    a.desktopSessionId === b.desktopSessionId &&
    a.process.processId === b.process.processId &&
    a.process.startIdentity === b.process.startIdentity &&
    a.generation === b.generation;
}

export function sameWindowsUiaControl(a: WindowsUiaControlRef, b: WindowsUiaControlRef): boolean {
  return sameWindowsUiaWindow(a.window, b.window) &&
    a.generation === b.generation &&
    a.controlType === b.controlType &&
    a.runtimeId.length === b.runtimeId.length &&
    a.runtimeId.every((part, index) => part === b.runtimeId[index]);
}

export function requiredWindowsUiaPattern(action: WindowsUiaSemanticAction): WindowsUiaPattern {
  switch (action.kind) {
    case 'invoke': return 'invoke';
    case 'set-value': return 'value';
    case 'toggle': return 'toggle';
    case 'select': return 'selection-item';
    case 'expand-collapse': return 'expand-collapse';
    case 'scroll': return 'scroll';
    case 'set-range-value': return 'range-value';
    case 'window': return 'window';
  }
}

export function validateWindowsUiaSemanticAction(action: WindowsUiaSemanticAction): boolean {
  return captureWindowsUiaSemanticAction(action) !== undefined;
}

function limits(input?: ComputerObservationLimits): Required<ComputerObservationLimits> {
  return Object.freeze({
    maxItems: Math.min(MAX_ITEMS, input?.maxItems ?? 256),
    maxTextBytes: Math.min(MAX_TEXT_BYTES, input?.maxTextBytes ?? 16_384),
    maxDepth: Math.min(MAX_DEPTH, input?.maxDepth ?? 16),
  });
}

function mapBackendResult(result: DesktopBackendActionResult): ComputerActionResult {
  if (result.dispatched) {
    return {
      status: result.status === 'completed' ? 'completed' : result.status === 'rejected' ? 'rejected' : result.status === 'unsupported' ? 'unsupported' : 'failed',
      dispatch: 'dispatched-once',
      verification: result.verified === true ? 'verified' : result.verified === false ? 'mismatch' : 'unverified',
      ...(result.evidence ? { evidence: Object.freeze([...result.evidence]) } : {}),
    };
  }
  return {
    status: result.status === 'completed' ? 'failed' : result.status,
    dispatch: 'not-dispatched',
    verification: 'unverified',
    ...(result.evidence ? { evidence: Object.freeze([...result.evidence]) } : {}),
  };
}

export class WindowsUiaSemanticRuntime {
  constructor(readonly provider: WindowsUiaProvider) {}

  async observe(window: WindowsUiaWindowRef, inputLimits?: ComputerObservationLimits): Promise<WindowsUiaCachedObservation> {
    const authority = captureWindowsUiaWindowRef(window);
    if (!authority) throw new Error('invalid-windows-uia-window-ref');
    return this.provider.observeCached(authority, limits(inputLimits));
  }

  async act(
    ref: WindowsUiaControlRef,
    action: WindowsUiaSemanticAction,
    effect: ComputerEffectClass,
  ): Promise<ComputerActionResult> {
    const authorityRef = captureWindowsUiaControlRef(ref);
    const authorityAction = captureWindowsUiaSemanticAction(action);
    if (!authorityRef || !authorityAction) {
      return { status:'rejected', dispatch:'not-dispatched', verification:'unverified', evidence:['windows-uia-request-invalid'] };
    }
    if (effect === 'observe-only') {
      return { status:'rejected', dispatch:'not-dispatched', verification:'unverified', evidence:['windows-uia-effect-invalid'] };
    }

    let currentRaw: WindowsUiaRevalidation;
    try {
      currentRaw = await this.provider.revalidateControl(authorityRef);
    } catch {
      return { status:'failed', dispatch:'not-dispatched', verification:'unverified', evidence:['windows-uia-revalidation-failed'] };
    }
    const current = captureRevalidation(currentRaw);
    if (!current) {
      return { status:'failed', dispatch:'not-dispatched', verification:'unverified', evidence:['windows-uia-revalidation-invalid'] };
    }
    if (current.status !== 'current') {
      return {
        status: current.status === 'inaccessible' ? 'unsupported' : 'rejected',
        dispatch:'not-dispatched',
        verification:'unverified',
        evidence: Object.freeze([`windows-uia-${current.status}`, ...(current.evidence ?? [])]),
      };
    }
    if (!sameWindowsUiaControl(authorityRef, current.control.ref)) {
      return { status:'rejected', dispatch:'not-dispatched', verification:'unverified', evidence:['windows-uia-control-replaced'] };
    }
    if (current.control.enabled === false) {
      return { status:'rejected', dispatch:'not-dispatched', verification:'unverified', evidence:['windows-uia-control-disabled'] };
    }
    const required = requiredWindowsUiaPattern(authorityAction);
    if (!current.control.patterns.includes(required)) {
      return { status:'unsupported', dispatch:'not-dispatched', verification:'unverified', evidence:['windows-uia-pattern-unsupported'] };
    }

    try {
      const rawResult = await this.provider.performSemanticAction(authorityRef, authorityAction, effect);
      const capturedResult = captureBackendResult(rawResult);
      if (!capturedResult) {
        return {status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['windows-uia-dispatch-result-invalid']};
      }
      return mapBackendResult(capturedResult);
    } catch {
      return { status:'unknown', dispatch:'unknown', verification:'unverified', evidence:['windows-uia-dispatch-uncertain'] };
    }
  }
}
