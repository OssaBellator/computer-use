import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LARGE_TRACKPAD_PROFILE,
  STANDARD_LAPTOP_PROFILE,
  deviceProfileEngineOptions,
  normalizeDeviceProfile,
} from '../src/config/deviceProfile.js';

test('standard device profile maps directly to touchpad and pointer controller options', () => {
  assert.deepEqual(deviceProfileEngineOptions(STANDARD_LAPTOP_PROFILE), {
    touchpadOptions: { widthMm: 120, heightMm: 80 },
    pointerOptions: {
      pixelsPerMm: 8,
      sampleIntervalMs: 8,
      liftDelayMs: 160,
    },
  });
});

test('normalization returns a defensive validated copy', () => {
  const copy = normalizeDeviceProfile(LARGE_TRACKPAD_PROFILE);
  assert.notEqual(copy, LARGE_TRACKPAD_PROFILE);
  assert.notEqual(copy.touchpad, LARGE_TRACKPAD_PROFILE.touchpad);
  assert.deepEqual(copy, LARGE_TRACKPAD_PROFILE);
});

test('invalid calibration values fail before an engine can be configured', () => {
  assert.throws(
    () => normalizeDeviceProfile({
      ...STANDARD_LAPTOP_PROFILE,
      touchpad: { ...STANDARD_LAPTOP_PROFILE.touchpad, pixelsPerMm: 0 },
    }),
    /pixelsPerMm/,
  );
  assert.throws(
    () => normalizeDeviceProfile({
      ...STANDARD_LAPTOP_PROFILE,
      touchpad: { ...STANDARD_LAPTOP_PROFILE.touchpad, liftDelayMs: -1 },
    }),
    /liftDelayMs/,
  );
});

test('profile IDs are normalized without mutating the source object', () => {
  const source = {
    ...STANDARD_LAPTOP_PROFILE,
    id: '  lab-profile  ',
    touchpad: { ...STANDARD_LAPTOP_PROFILE.touchpad },
  };
  const normalized = normalizeDeviceProfile(source);
  assert.equal(normalized.id, 'lab-profile');
  assert.equal(source.id, '  lab-profile  ');
});
