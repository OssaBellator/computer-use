import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpInteractionObserver } from '../src/browser/cdpObserver.js';
import { CoalescingInteractionObserver } from '../src/browser/coalescingObserver.js';
import { STANDARD_LAPTOP_PROFILE } from '../src/config/deviceProfile.js';
import { createCdpInteractionEngine } from '../src/engine/cdpInteractionEngine.js';
import { InteractionEngine } from '../src/engine/interactionEngine.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { Point } from '../src/types.js';

const observer: BrowserInteractionObserver = {
  async snapshot() { return []; },
  async targetPoint() { return null; },
  async pointStillTargets() { return false; },
};

const input: BrowserInput = {
  async movePointer(_point: Point) {},
  async pointerDown(_button?: MouseButton) {},
  async pointerUp(_button?: MouseButton) {},
  async pressKey(_key: string) {},
  async keyDown(_key: string) {},
  async keyUp(_key: string) {},
  async typeText(_text: string, _delayMs?: number) {},
  async scroll(_delta: Point) {},
};

test('engine applies device profile touchpad geometry and allows explicit overrides', () => {
  const profiled = new InteractionEngine(observer, input, {
    deviceProfile: STANDARD_LAPTOP_PROFILE,
  });
  assert.equal(profiled.touchpad.widthMm, 120);
  assert.equal(profiled.touchpad.heightMm, 80);

  const overridden = new InteractionEngine(observer, input, {
    deviceProfile: STANDARD_LAPTOP_PROFILE,
    touchpadOptions: { widthMm: 150 },
  });
  assert.equal(overridden.touchpad.widthMm, 150);
  assert.equal(overridden.touchpad.heightMm, 80);
});

test('CDP factory coalesces concurrent observations by default and supports opt-out', () => {
  const page = { frames: () => [] };
  const session = { async send() { return {}; } };
  const defaultEngine = createCdpInteractionEngine(page, session);
  assert.ok(defaultEngine.observer instanceof CoalescingInteractionObserver);

  const rawEngine = createCdpInteractionEngine(page, session, { coalesceSnapshots: false });
  assert.ok(rawEngine.observer instanceof CdpInteractionObserver);
});
