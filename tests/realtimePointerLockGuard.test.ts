import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeControlLoop } from '../src/agent/realtimeControlLoop.js';
import {
  PointerLockController,
  PointerLockRequiredError,
  guardRelativePointerInput,
} from '../src/controller/pointerLockController.js';
import type { PointerLockObservation } from '../src/browser/pointerLockState.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { Point } from '../src/types.js';

class Input implements BrowserInput {
  readonly events: string[] = [];
  async movePointer(point: Point): Promise<void> { this.events.push(`move:${point.x},${point.y}`); }
  async movePointerBy(delta: Point): Promise<void> { this.events.push(`moveBy:${delta.x},${delta.y}`); }
  async pointerDown(button: MouseButton = 'left'): Promise<void> { this.events.push(`pointerDown:${button}`); }
  async pointerUp(button: MouseButton = 'left'): Promise<void> { this.events.push(`pointerUp:${button}`); }
  async pressKey(key: string): Promise<void> { this.events.push(`press:${key}`); }
  async keyDown(key: string): Promise<void> { this.events.push(`keyDown:${key}`); }
  async keyUp(key: string): Promise<void> { this.events.push(`keyUp:${key}`); }
  async typeText(text: string): Promise<void> { this.events.push(`type:${text}`); }
  async scroll(delta: Point): Promise<void> { this.events.push(`scroll:${delta.x},${delta.y}`); }
}

class Observer {
  constructor(private readonly observation: PointerLockObservation) {}
  async observeLock(): Promise<PointerLockObservation> { return this.observation; }
}

test('existing realtime pointerDelta fails closed when guarded lock is required but absent', async () => {
  const input = new Input();
  const controller = new PointerLockController(
    input,
    new Observer({ supported: true, locked: false, focused: true }),
  );
  const guarded = guardRelativePointerInput(input, controller, { requirement: 'required' });
  const loop = new RealtimeControlLoop(guarded, {
    observe: async () => null,
    decide: () => ({ heldKeys: ['w'], pointerDelta: { x: 4, y: -1 } }),
    tickIntervalMs: 0,
    maxTicks: 1,
    maxDurationMs: 100,
  });

  await assert.rejects(loop.run(), PointerLockRequiredError);
  assert.deepEqual(input.events, []);
});

test('existing realtime loop can explicitly degrade pointerDelta while preserving held-input cleanup', async () => {
  const input = new Input();
  const controller = new PointerLockController(
    input,
    new Observer({ supported: true, locked: false, focused: true }),
  );
  const degraded: string[] = [];
  const guarded = guardRelativePointerInput(input, controller, {
    requirement: 'preferred',
    onDegraded: (event) => { degraded.push(event.status); },
  });
  const result = await new RealtimeControlLoop(guarded, {
    observe: async () => null,
    decide: ({ tick }) => tick === 0
      ? { heldKeys: ['w'], pointerDelta: { x: 4, y: -1 } }
      : { stop: true, reason: 'done' },
    tickIntervalMs: 0,
    maxTicks: 2,
    maxDurationMs: 100,
  }).run();

  assert.equal(result.status, 'stopped');
  assert.deepEqual(degraded, ['unavailable']);
  assert.deepEqual(input.events, ['keyDown:w', 'keyUp:w']);
});
