import { describe, expect, it } from 'vitest';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import { PointerController } from '../src/controller/pointerController.js';
import { VirtualTouchpad } from '../src/motor/virtualTouchpad.js';
import type { Point } from '../src/types.js';

class RecordingInput implements BrowserInput {
  readonly moves: Point[] = [];
  readonly buttons: string[] = [];

  async movePointer(point: Point): Promise<void> {
    this.moves.push({ ...point });
  }
  async pointerDown(button: MouseButton = 'left'): Promise<void> {
    this.buttons.push(`down:${button}`);
  }
  async pointerUp(button: MouseButton = 'left'): Promise<void> {
    this.buttons.push(`up:${button}`);
  }
  async pressKey(): Promise<void> {}
  async keyDown(): Promise<void> {}
  async keyUp(): Promise<void> {}
  async typeText(): Promise<void> {}
  async scroll(): Promise<void> {}
}

describe('VirtualTouchpad', () => {
  it('rejects movement outside the bounded finger surface', () => {
    const pad = new VirtualTouchpad({ widthMm: 20, heightMm: 10 });
    pad.touchDown();

    expect(pad.applyFingerDelta({ x: 9, y: 0 }).boundaryReached).toBe(false);
    expect(pad.applyFingerDelta({ x: 2, y: 0 }).boundaryReached).toBe(true);
    expect(pad.finger).toEqual({ x: 9, y: 0 });
  });

  it('recenters the finger without moving the cursor', () => {
    const pad = new VirtualTouchpad({ initialCursor: { x: 100, y: 50 } });
    pad.applyFingerDelta({ x: 5, y: 3 });
    const cursorBeforeLift = { ...pad.cursor };

    pad.liftAndRecenter();

    expect(pad.finger).toEqual({ x: 0, y: 0 });
    expect(pad.cursor).toEqual(cursorBeforeLift);
    expect(pad.state).toBe('contact');
  });
});

describe('PointerController', () => {
  it('finishes exactly on the target and emits a click through the adapter', async () => {
    const input = new RecordingInput();
    const pad = new VirtualTouchpad({ initialCursor: { x: 0, y: 0 } });
    const controller = new PointerController(input, pad, {
      sleep: async () => {},
      sampleIntervalMs: 16,
    });

    await controller.click({ x: 120, y: 40 }, 24);

    expect(input.moves.at(-1)).toEqual({ x: 120, y: 40 });
    expect(pad.cursor).toEqual({ x: 120, y: 40 });
    expect(input.buttons).toEqual(['down:left', 'up:left']);
  });
});
