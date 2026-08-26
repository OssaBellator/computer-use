import type { WindowsUiaWindowRef } from './windowsUiaContract.js';

export interface WindowsVisualGeometry {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
  /** Effective DPI for the captured window coordinate space. */
  readonly dpi: number;
}

export interface WindowsVisualFrameRef {
  readonly window: WindowsUiaWindowRef;
  readonly frameSequence: number;
  readonly captureGeneration: number;
  readonly capturedAtMs: number;
  readonly contentWidth: number;
  readonly contentHeight: number;
  readonly geometry: WindowsVisualGeometry;
}

export interface WindowsVisualPointBinding {
  readonly frame: WindowsVisualFrameRef;
  readonly x: number;
  readonly y: number;
}

export type WindowsVisualBindingValidation =
  | { readonly status:'valid' }
  | { readonly status:'window-stale' | 'capture-stale' | 'geometry-changed' | 'point-out-of-bounds' };

function finiteInteger(value: number): boolean {
  return Number.isSafeInteger(value);
}

export function sameWindowsVisualGeometry(a: WindowsVisualGeometry, b: WindowsVisualGeometry): boolean {
  return a.left === b.left &&
    a.top === b.top &&
    a.width === b.width &&
    a.height === b.height &&
    a.dpi === b.dpi;
}

/**
 * Coordinate bindings are valid only for the exact window/capture generation
 * and geometry from which they were derived. A resize, move, DPI change, or
 * capture-generation change invalidates them.
 */
export function validateWindowsVisualPointBinding(
  binding: WindowsVisualPointBinding,
  current: WindowsVisualFrameRef,
): WindowsVisualBindingValidation {
  const source = binding.frame;
  if (source.window.hwnd !== current.window.hwnd ||
      source.window.desktopSessionId !== current.window.desktopSessionId ||
      source.window.process.processId !== current.window.process.processId ||
      source.window.process.startIdentity !== current.window.process.startIdentity ||
      source.window.generation !== current.window.generation) {
    return Object.freeze({status:'window-stale'});
  }
  if (source.captureGeneration !== current.captureGeneration ||
      source.frameSequence !== current.frameSequence) {
    return Object.freeze({status:'capture-stale'});
  }
  if (!sameWindowsVisualGeometry(source.geometry,current.geometry) ||
      source.contentWidth !== current.contentWidth ||
      source.contentHeight !== current.contentHeight) {
    return Object.freeze({status:'geometry-changed'});
  }
  if (!finiteInteger(binding.x) || !finiteInteger(binding.y) ||
      binding.x < 0 || binding.y < 0 ||
      binding.x >= source.contentWidth || binding.y >= source.contentHeight) {
    return Object.freeze({status:'point-out-of-bounds'});
  }
  return Object.freeze({status:'valid'});
}
