import type { DesktopVisualAcquisitionLimits, DesktopVisualArtifactRef } from './desktopUiBackend.js';
import type { WindowsUiaWindowRef } from './windowsUiaContract.js';
import { sameWindowsUiaWindow } from './windowsUiaContract.js';
import type { WindowsVisualFrameRef, WindowsVisualGeometry } from './windowsVisualFrame.js';

export interface WindowsGraphicsCaptureNativeFrame {
  readonly window:WindowsUiaWindowRef;
  readonly captureGeneration:number;
  readonly frameSequence:number;
  readonly capturedAtMs:number;
  /** Optional QPC-derived WinRT SystemRelativeTime expressed as 100ns ticks. */
  readonly systemRelativeTime100ns?:number;
  readonly contentWidth:number;
  readonly contentHeight:number;
  readonly geometry:WindowsVisualGeometry;
  readonly artifact:DesktopVisualArtifactRef;
}

export interface WindowsGraphicsCaptureNativeBridge {
  /**
   * Capture the next frame for exactly one HWND using Windows.Graphics.Capture.
   * Native implementations should create the GraphicsCaptureItem with
   * IGraphicsCaptureItemInterop::CreateForWindow and use a free-threaded frame
   * pool so capture callbacks do not depend on a UI DispatcherQueue.
   */
  captureNextFrame(
    window:WindowsUiaWindowRef,
    limits:DesktopVisualAcquisitionLimits,
  ):Promise<WindowsGraphicsCaptureNativeFrame>;

  /** Release backend-owned encoded/surface material for an artifact token. */
  releaseArtifact(token:string):Promise<void>;
  /** Atomically revoke and return a bounded artifact payload for immediate perception. */
  consumeArtifact?(token:string,maxBytes:number):Promise<Readonly<{mediaType:string;bytes:Uint8Array}>>;
}

export interface WindowsGraphicsCaptureObservation {
  readonly frame:WindowsVisualFrameRef;
  readonly artifact:DesktopVisualArtifactRef;
  readonly systemRelativeTime100ns?:number;
}

const TOKEN_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,191}$/i;
const MEDIA_TYPE_PATTERN = /^[a-z0-9][a-z0-9.+-]{0,63}\/[a-z0-9][a-z0-9.+-]{0,63}$/i;
const MAX_DIMENSION = 32_768;

function validPositiveInt(value:number,max=Number.MAX_SAFE_INTEGER):boolean {
  return Number.isSafeInteger(value) && value > 0 && value <= max;
}
function validNonNegativeInt(value:number):boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
function validGeometry(value:WindowsVisualGeometry):boolean {
  return Number.isFinite(value.left) && Number.isFinite(value.top) &&
    validPositiveInt(value.width,MAX_DIMENSION) && validPositiveInt(value.height,MAX_DIMENSION) &&
    Number.isFinite(value.dpi) && value.dpi >= 48 && value.dpi <= 960;
}
function key(window:WindowsUiaWindowRef):string {
  return `${window.desktopSessionId}:${window.hwnd}:${window.process.processId}:${window.process.startIdentity}:${window.generation}`;
}

/**
 * Validates and generation-binds HWND capture frames before they can be used for
 * visual grounding. Raw image bytes remain owned by the native backend.
 */
export class WindowsGraphicsCaptureRuntime {
  private readonly last = new Map<string,{captureGeneration:number;frameSequence:number}>();

  constructor(readonly bridge:WindowsGraphicsCaptureNativeBridge) {}

  async capture(
    window:WindowsUiaWindowRef,
    limits:DesktopVisualAcquisitionLimits,
  ):Promise<WindowsGraphicsCaptureObservation> {
    if (!validPositiveInt(limits.maxPixels) || !validPositiveInt(limits.maxBytes)) {
      throw new Error('windows-capture-limits-invalid');
    }
    const native = await this.bridge.captureNextFrame(window,Object.freeze({...limits}));
    if (!sameWindowsUiaWindow(native.window,window)) throw new Error('windows-capture-window-mismatch');
    if (!validNonNegativeInt(native.captureGeneration) || !validNonNegativeInt(native.frameSequence) ||
        !validNonNegativeInt(native.capturedAtMs) ||
        !validPositiveInt(native.contentWidth,MAX_DIMENSION) || !validPositiveInt(native.contentHeight,MAX_DIMENSION) ||
        !validGeometry(native.geometry)) {
      throw new Error('windows-capture-frame-invalid');
    }
    const pixels = native.contentWidth * native.contentHeight;
    if (!Number.isSafeInteger(pixels) || pixels > limits.maxPixels) throw new Error('windows-capture-pixel-limit-exceeded');
    if (!TOKEN_PATTERN.test(native.artifact.token) || !validNonNegativeInt(native.artifact.byteLength) ||
        native.artifact.byteLength > limits.maxBytes ||
        (native.artifact.mediaType !== undefined && !MEDIA_TYPE_PATTERN.test(native.artifact.mediaType))) {
      throw new Error('windows-capture-artifact-invalid');
    }
    if (native.systemRelativeTime100ns !== undefined && !validNonNegativeInt(native.systemRelativeTime100ns)) {
      throw new Error('windows-capture-time-invalid');
    }

    const previous = this.last.get(key(window));
    if (previous) {
      if (native.captureGeneration < previous.captureGeneration) throw new Error('windows-capture-generation-regressed');
      if (native.captureGeneration === previous.captureGeneration && native.frameSequence <= previous.frameSequence) {
        throw new Error('windows-capture-frame-sequence-not-increasing');
      }
    }
    this.last.set(key(window),{captureGeneration:native.captureGeneration,frameSequence:native.frameSequence});

    const frame:WindowsVisualFrameRef = Object.freeze({
      window,
      captureGeneration:native.captureGeneration,
      frameSequence:native.frameSequence,
      capturedAtMs:native.capturedAtMs,
      contentWidth:native.contentWidth,
      contentHeight:native.contentHeight,
      geometry:Object.freeze({...native.geometry}),
    });
    return Object.freeze({
      frame,
      artifact:Object.freeze({...native.artifact}),
      ...(native.systemRelativeTime100ns !== undefined ? {systemRelativeTime100ns:native.systemRelativeTime100ns} : {}),
    });
  }

  release(observation:WindowsGraphicsCaptureObservation):Promise<void> {
    return this.bridge.releaseArtifact(observation.artifact.token);
  }
}
