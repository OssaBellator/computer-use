import type { ComputerEffectClass, ComputerObservationLimits } from './environmentAdapter.js';

export interface DesktopApplicationIdentity {
  /** Backend-stable application identity when the OS exposes one. */
  applicationId?: string;
  /** Opaque process identity. It is deliberately not an OS-native PID type. */
  processId?: string;
}

export interface DesktopNativeWindowRef {
  nativeWindowId: string;
  generation: number;
}

export interface DesktopWindowSnapshot extends DesktopNativeWindowRef {
  application?: DesktopApplicationIdentity;
  title?: string;
  bounds?: DesktopRect;
  foreground: boolean;
  focused: boolean;
}

export interface DesktopRect { x:number; y:number; width:number; height:number; }

export interface DesktopAccessibilityNode {
  controlId: string;
  role?: string;
  name?: string;
  value?: string;
  enabled?: boolean;
  focused?: boolean;
  bounds?: DesktopRect;
  children?: readonly DesktopAccessibilityNode[];
}

export type DesktopAccessibilityStatus = 'available' | 'unavailable' | 'unsupported';
export interface DesktopAccessibilityObservation {
  status: DesktopAccessibilityStatus;
  window: DesktopNativeWindowRef;
  root?: DesktopAccessibilityNode;
  reason?: string;
}

export type DesktopVisualStatus = 'available' | 'unavailable' | 'unsupported';

/** Adapter-owned hard bounds that a backend must honor before capture materialization. */
export interface DesktopVisualAcquisitionLimits {
  maxPixels: number;
  maxBytes: number;
}

/**
 * Bounded reference to a backend-owned visual capture. Raw pixel/image payloads
 * do not cross the neutral computer-use contract in phase 1.
 */
export interface DesktopVisualArtifactRef {
  /** Opaque backend-local token that can identify a capture to a typed caller. */
  token: string;
  /** Optional bounded media-type hint, for example image/png. */
  mediaType?: string;
  /** Optional size of the backend-owned capture, not inline bytes. */
  byteLength?: number;
}

export interface DesktopVisualObservation {
  status: DesktopVisualStatus;
  window: DesktopNativeWindowRef;
  width?: number;
  height?: number;
  artifact?: DesktopVisualArtifactRef;
  reason?: string;
}

export interface DesktopSystemObservation {
  /** Already bounded by the limits supplied to observeSystem(). */
  windows: readonly DesktopWindowSnapshot[];
  /** True when the backend stopped enumeration because an observation limit was reached. */
  truncated: boolean;
  foregroundWindow?: DesktopNativeWindowRef;
  focusedWindow?: DesktopNativeWindowRef;
  focusedControlId?: string;
}

export type DesktopKeyboardInput =
  | { kind: 'key-down' | 'key-up'; key: string; modifiers?: readonly ('alt'|'control'|'meta'|'shift')[] }
  | { kind: 'text'; text: string };

export interface DesktopAbsolutePointerInput {
  x: number;
  y: number;
  button?: 'left'|'middle'|'right';
  kind: 'move'|'down'|'up'|'click';
}

export interface DesktopRelativePointerInput {
  dx: number;
  dy: number;
}

export interface DesktopBackendActionResult {
  status: 'completed' | 'rejected' | 'unsupported' | 'failed';
  dispatched: boolean;
  verified?: boolean;
  evidence?: readonly string[];
}

export interface DesktopFocusTarget {
  window: DesktopNativeWindowRef;
  controlId?: string;
}

/** OS-specific adapters implement this interface outside the computer-use core. */
export interface NativeDesktopUiBackend {
  readonly id: string;
  readonly supportsRelativePointer?: boolean;
  /**
   * Backends must stop enumeration before materializing more than these limits.
   * The adapter re-validates/re-bounds the returned metadata defensively.
   */
  observeSystem(limits: Required<ComputerObservationLimits>): Promise<DesktopSystemObservation>;
  observeAccessibility(window: DesktopNativeWindowRef, limits: Required<ComputerObservationLimits>): Promise<DesktopAccessibilityObservation>;
  /** Backends must honor these frozen limits before allocating/capturing pixels or encoded bytes. */
  observeVisual(window: DesktopNativeWindowRef, limits: DesktopVisualAcquisitionLimits): Promise<DesktopVisualObservation>;
  focus(target: DesktopFocusTarget, effect: ComputerEffectClass): Promise<DesktopBackendActionResult>;
  keyboard(window: DesktopNativeWindowRef, input: DesktopKeyboardInput, effect: ComputerEffectClass): Promise<DesktopBackendActionResult>;
  pointerAbsolute(window: DesktopNativeWindowRef, input: DesktopAbsolutePointerInput, effect: ComputerEffectClass): Promise<DesktopBackendActionResult>;
  pointerRelative?(window: DesktopNativeWindowRef, input: DesktopRelativePointerInput, effect: ComputerEffectClass): Promise<DesktopBackendActionResult>;
}
