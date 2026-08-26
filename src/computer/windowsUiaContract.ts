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
const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedString(value: unknown, maxBytes = MAX_ID_BYTES): value is string {
  return typeof value === 'string' && value.length > 0 && !value.includes('\0') && utf8Bytes(value) <= maxBytes;
}

function validGeneration(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function validProcess(value: WindowsProcessGeneration): boolean {
  return Number.isSafeInteger(value.processId) && value.processId > 0 && boundedString(value.startIdentity);
}

export function validateWindowsUiaWindowRef(ref: WindowsUiaWindowRef): boolean {
  return boundedString(ref.hwnd) &&
    boundedString(ref.desktopSessionId) &&
    validProcess(ref.process) &&
    validGeneration(ref.generation);
}

export function validateWindowsUiaControlRef(ref: WindowsUiaControlRef): boolean {
  if (!validateWindowsUiaWindowRef(ref.window) ||
      !Array.isArray(ref.runtimeId) ||
      ref.runtimeId.length === 0 ||
      ref.runtimeId.length > MAX_RUNTIME_ID_PARTS ||
      ref.runtimeId.some((part) => !Number.isSafeInteger(part)) ||
      !boundedString(ref.controlType) ||
      !validGeneration(ref.generation)) return false;
  if (ref.automationId !== undefined && !boundedString(ref.automationId)) return false;
  if (ref.structuralPathHash !== undefined && !TOKEN_PATTERN.test(ref.structuralPathHash)) return false;
  return true;
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
  switch (action.kind) {
    case 'set-value':
      return boundedString(action.value, MAX_VALUE_BYTES);
    case 'set-range-value':
      return Number.isFinite(action.value);
    case 'invoke':
    case 'toggle':
    case 'select':
    case 'expand-collapse':
    case 'scroll':
    case 'window':
      return true;
  }
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

  observe(window: WindowsUiaWindowRef, inputLimits?: ComputerObservationLimits): Promise<WindowsUiaCachedObservation> {
    if (!validateWindowsUiaWindowRef(window)) return Promise.reject(new Error('invalid-windows-uia-window-ref'));
    return this.provider.observeCached(window, limits(inputLimits));
  }

  async act(
    ref: WindowsUiaControlRef,
    action: WindowsUiaSemanticAction,
    effect: ComputerEffectClass,
  ): Promise<ComputerActionResult> {
    if (!validateWindowsUiaControlRef(ref) || !validateWindowsUiaSemanticAction(action)) {
      return { status:'rejected', dispatch:'not-dispatched', verification:'unverified', evidence:['windows-uia-request-invalid'] };
    }
    if (effect === 'observe-only') {
      return { status:'rejected', dispatch:'not-dispatched', verification:'unverified', evidence:['windows-uia-effect-invalid'] };
    }

    let current: WindowsUiaRevalidation;
    try {
      current = await this.provider.revalidateControl(ref);
    } catch {
      return { status:'failed', dispatch:'not-dispatched', verification:'unverified', evidence:['windows-uia-revalidation-failed'] };
    }
    if (current.status !== 'current') {
      return {
        status: current.status === 'inaccessible' ? 'unsupported' : 'rejected',
        dispatch:'not-dispatched',
        verification:'unverified',
        evidence: Object.freeze([`windows-uia-${current.status}`, ...(current.evidence ?? [])]),
      };
    }
    if (!sameWindowsUiaControl(ref, current.control.ref)) {
      return { status:'rejected', dispatch:'not-dispatched', verification:'unverified', evidence:['windows-uia-control-replaced'] };
    }
    if (current.control.enabled === false) {
      return { status:'rejected', dispatch:'not-dispatched', verification:'unverified', evidence:['windows-uia-control-disabled'] };
    }
    const required = requiredWindowsUiaPattern(action);
    if (!current.control.patterns.includes(required)) {
      return { status:'unsupported', dispatch:'not-dispatched', verification:'unverified', evidence:['windows-uia-pattern-unsupported'] };
    }

    try {
      return mapBackendResult(await this.provider.performSemanticAction(ref, action, effect));
    } catch {
      return { status:'unknown', dispatch:'unknown', verification:'unverified', evidence:['windows-uia-dispatch-uncertain'] };
    }
  }
}
