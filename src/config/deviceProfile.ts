import type { PointerControllerOptions } from '../controller/pointerController.js';
import type { VirtualTouchpadOptions } from '../motor/virtualTouchpad.js';

export type KeyboardLayoutId = 'us';

export interface TouchpadCalibrationProfile {
  widthMm: number;
  heightMm: number;
  pixelsPerMm: number;
  sampleIntervalMs: number;
  liftDelayMs: number;
}

export interface InteractionDeviceProfile {
  id: string;
  keyboardLayout: KeyboardLayoutId;
  touchpad: TouchpadCalibrationProfile;
}

export interface DeviceProfileEngineOptions {
  touchpadOptions: VirtualTouchpadOptions;
  pointerOptions: PointerControllerOptions;
}

export const STANDARD_LAPTOP_PROFILE: InteractionDeviceProfile = {
  id: 'standard-laptop-120x80',
  keyboardLayout: 'us',
  touchpad: {
    widthMm: 120,
    heightMm: 80,
    pixelsPerMm: 8,
    sampleIntervalMs: 8,
    liftDelayMs: 160,
  },
};

export const LARGE_TRACKPAD_PROFILE: InteractionDeviceProfile = {
  id: 'large-trackpad-135x90',
  keyboardLayout: 'us',
  touchpad: {
    widthMm: 135,
    heightMm: 90,
    pixelsPerMm: 8,
    sampleIntervalMs: 8,
    liftDelayMs: 160,
  },
};

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
  return value;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a non-negative finite number`);
  }
  return value;
}

/** Returns a validated defensive copy suitable for persistent test configuration. */
export function normalizeDeviceProfile(profile: InteractionDeviceProfile): InteractionDeviceProfile {
  const id = profile.id.trim();
  if (!id) throw new Error('profile id must not be empty');
  if (profile.keyboardLayout !== 'us') {
    throw new Error(`unsupported keyboard layout: ${String(profile.keyboardLayout)}`);
  }
  return {
    id,
    keyboardLayout: profile.keyboardLayout,
    touchpad: {
      widthMm: positiveFinite(profile.touchpad.widthMm, 'touchpad.widthMm'),
      heightMm: positiveFinite(profile.touchpad.heightMm, 'touchpad.heightMm'),
      pixelsPerMm: positiveFinite(profile.touchpad.pixelsPerMm, 'touchpad.pixelsPerMm'),
      sampleIntervalMs: positiveFinite(profile.touchpad.sampleIntervalMs, 'touchpad.sampleIntervalMs'),
      liftDelayMs: nonNegativeFinite(profile.touchpad.liftDelayMs, 'touchpad.liftDelayMs'),
    },
  };
}

/** Maps a deterministic calibration profile onto the existing engine constructors. */
export function deviceProfileEngineOptions(
  profile: InteractionDeviceProfile,
): DeviceProfileEngineOptions {
  const normalized = normalizeDeviceProfile(profile);
  return {
    touchpadOptions: {
      widthMm: normalized.touchpad.widthMm,
      heightMm: normalized.touchpad.heightMm,
    },
    pointerOptions: {
      pixelsPerMm: normalized.touchpad.pixelsPerMm,
      sampleIntervalMs: normalized.touchpad.sampleIntervalMs,
      liftDelayMs: normalized.touchpad.liftDelayMs,
    },
  };
}
