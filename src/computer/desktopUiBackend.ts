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
export interface DesktopVisualObservation {
  status: DesktopVisualStatus;
  window: DesktopNativeWindowRef;
  width?: number;
  height?: number;
  /** Opaque capture token/metadata owned by the backend, not assumed to be pixels. */
  artifact?: unknown;
  reason?: string;
}

export interface DesktopSystemObservation {
  windows: readonly DesktopWindowSnapshot[];
  foregroundWindow?: DesktopNativeWindowRef;
  focusedWindow?: DesktopNativeWindowRef;
  focusedControlId?: string;
}

export interface DesktopKeyboardInput {
  kind: 'key-down' | 'key-up' | 'text';
  key?: string;
  text?: string;
  modifiers?: readonly ('alt'|'control'|'meta'|'shift')[];
}

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
  observeSystem(): Promise<DesktopSystemObservation>;
  observeAccessibility(window: DesktopNativeWindowRef, limits: Required<ComputerObservationLimits>): Promise<DesktopAccessibilityObservation>;
  observeVisual(window: DesktopNativeWindowRef): Promise<DesktopVisualObservation>;
  focus(target: DesktopFocusTarget, effect: ComputerEffectClass): Promise<DesktopBackendActionResult>;
  keyboard(window: DesktopNativeWindowRef, input: DesktopKeyboardInput, effect: ComputerEffectClass): Promise<DesktopBackendActionResult>;
  pointerAbsolute(window: DesktopNativeWindowRef, input: DesktopAbsolutePointerInput, effect: ComputerEffectClass): Promise<DesktopBackendActionResult>;
  pointerRelative?(window: DesktopNativeWindowRef, input: DesktopRelativePointerInput, effect: ComputerEffectClass): Promise<DesktopBackendActionResult>;
}
