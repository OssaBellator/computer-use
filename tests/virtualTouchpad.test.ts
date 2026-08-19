import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import { PointerController } from '../src/controller/pointerController.js';
import { VirtualTouchpad, createVelocityGainTransfer } from '../src/motor/virtualTouchpad.js';
import type { Point } from '../src/types.js';

class RecordingInput implements BrowserInput {
  readonly moves: Point[] = [];
  readonly buttons: string[] = [];
  async movePointer(point: Point): Promise<void> { this.moves.push({ ...point }); }
  async pointerDown(button: MouseButton = 'left'): Promise<void> { this.buttons.push(`down:${button}`); }
  async pointerUp(button: MouseButton = 'left'): Promise<void> { this.buttons.push(`up:${button}`); }
  async pressKey(): Promise<void> {}
  async keyDown(): Promise<void> {}
  async keyUp(): Promise<void> {}
  async typeText(): Promise<void> {}
  async scroll(): Promise<void> {}
}

test('touchpad rejects movement outside its bounded surface without mutating state', () => {
  const pad = new VirtualTouchpad({ widthMm: 20, heightMm: 10 });
  pad.touchDown();
  assert.equal(pad.applyFingerDelta({ x: 9, y: 0 }).boundaryReached, false);
  const cursorBefore = { ...pad.cursor };
  assert.equal(pad.applyFingerDelta({ x: 2, y: 0 }).boundaryReached, true);
  assert.deepEqual(pad.finger, { x: 9, y: 0 });
  assert.deepEqual(pad.cursor, cursorBefore);
});

test('lift/recenter preserves viewport cursor', () => {
  const pad = new VirtualTouchpad({
    initialCursor: { x: 100, y: 50 },
    transferFunction: createVelocityGainTransfer(8, 0),
  });
  pad.applyFingerDelta({ x: 5, y: 3 });
  const cursorBefore = { ...pad.cursor };
  pad.liftAndRecenter();
  assert.deepEqual(pad.finger, { x: 0, y: 0 });
  assert.deepEqual(pad.cursor, cursorBefore);
  assert.equal(pad.state, 'contact');
});

test('velocity-gain transfer responds to speed deterministically', () => {
  const transfer = createVelocityGainTransfer(8, 0.01);
  assert.ok(
    transfer({ x: 1, y: 0 }, { x: 100, y: 0 }).x >
      transfer({ x: 1, y: 0 }, { x: 0, y: 0 }).x,
  );
});

test('pointer controller reaches target and emits ordered click events', async () => {
  const input = new RecordingInput();
  const pad = new VirtualTouchpad({ initialCursor: { x: 0, y: 0 } });
  const controller = new PointerController(input, pad, { sleep: async () => {}, sampleIntervalMs: 16 });
  await controller.click({ x: 120, y: 40 }, 24);
  assert.deepEqual(input.moves.at(-1), { x: 120, y: 40 });
  assert.deepEqual(pad.cursor, { x: 120, y: 40 });
  assert.deepEqual(input.buttons, ['down:left', 'up:left']);
});

test('pointer controller performs lift/recenter for long travel on a small pad', async () => {
  const input = new RecordingInput();
  const pad = new VirtualTouchpad({ widthMm: 10, heightMm: 10, initialCursor: { x: 0, y: 0 } });
  let liftSleeps = 0;
  const controller = new PointerController(input, pad, {
    pixelsPerMm: 1,
    sampleIntervalMs: 30,
    liftDelayMs: 10,
    sleep: async (ms) => { if (ms === 10) liftSleeps += 1; },
  });
  await controller.moveTo({ x: 100, y: 0 }, 10);
  assert.ok(liftSleeps > 0);
  assert.deepEqual(input.moves.at(-1), { x: 100, y: 0 });
});

test('pointer controller splits a single oversized sample into bounded strokes', async () => {
  const input = new RecordingInput();
  const pad = new VirtualTouchpad({ widthMm: 10, heightMm: 10, initialCursor: { x: 0, y: 0 } });
  let liftSleeps = 0;
  const controller = new PointerController(input, pad, {
    pixelsPerMm: 1,
    sampleIntervalMs: 10_000,
    liftDelayMs: 7,
    sleep: async (ms) => { if (ms === 7) liftSleeps += 1; },
  });
  await controller.moveTo({ x: 100, y: 0 }, 10);
  assert.ok(input.moves.length > 2);
  assert.ok(liftSleeps > 0);
  assert.deepEqual(input.moves.at(-1), { x: 100, y: 0 });
  assert.ok(Math.abs(pad.finger.x) <= pad.widthMm / 2);
});
