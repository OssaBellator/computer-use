import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PointerLockController,
  PointerLockRequiredError,
} from '../src/controller/pointerLockController.js';
import type { PointerLockObservation } from '../src/browser/pointerLockState.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { Point } from '../src/types.js';

class Input implements BrowserInput {
  readonly events: string[] = [];
  async movePointer(point: Point): Promise<void> { this.events.push(`move:${point.x},${point.y}`); }
  async movePointerBy(delta: Point): Promise<void> { this.events.push(`moveBy:${delta.x},${delta.y}`); }
  async pointerDown(button: MouseButton = 'left'): Promise<void> { this.events.push(`down:${button}`); }
  async pointerUp(button: MouseButton = 'left'): Promise<void> { this.events.push(`up:${button}`); }
  async pressKey(key: string): Promise<void> { this.events.push(`press:${key}`); }
  async keyDown(key: string): Promise<void> { this.events.push(`keyDown:${key}`); }
  async keyUp(key: string): Promise<void> { this.events.push(`keyUp:${key}`); }
  async typeText(text: string): Promise<void> { this.events.push(`type:${text}`); }
  async scroll(delta: Point): Promise<void> { this.events.push(`scroll:${delta.x},${delta.y}`); }
}

class Observer {
  private readonly states: PointerLockObservation[];
  readonly fallback: PointerLockObservation;
  calls = 0;

  constructor(states: PointerLockObservation[]) {
    this.states = [...states];
    this.fallback = states.at(-1) ?? { supported: true, locked: false, focused: true };
  }

  async observeLock(): Promise<PointerLockObservation> {
    this.calls += 1;
    return this.states.shift() ?? this.fallback;
  }
}

test('acquisition retries are hard bounded and may recover on a later request', async () => {
  const input = new Input();
  const observer = new Observer([
    { supported: true, locked: false, focused: true },
    { supported: true, locked: false, focused: true },
    { supported: true, locked: false, focused: true },
    { supported: true, locked: true, focused: true, owner: { backendNodeId: 8 } },
  ]);
  const controller = new PointerLockController(input, observer, { sleep: async () => {} });
  let requests = 0;
  const result = await controller.acquire({
    owner: { backendNodeId: 8 },
    request: async () => { requests += 1; },
    maxAttempts: 2,
    pollsPerAttempt: 2,
    pollIntervalMs: 0,
  });

  assert.equal(result.status, 'locked');
  assert.equal(result.attempts, 2);
  assert.equal(requests, 2);
  assert.equal(observer.calls, 4);
});

test('required relative movement fails closed while lock is absent', async () => {
  const input = new Input();
  const controller = new PointerLockController(input, new Observer([
    { supported: true, locked: false, focused: true },
  ]));

  await assert.rejects(
    controller.moveRelative({ x: 4, y: -2 }, { requirement: 'required' }),
    (error) => error instanceof PointerLockRequiredError && error.status === 'unavailable',
  );
  assert.deepEqual(input.events, []);
});

test('preferred lock degrades only through an explicit callback and does not dispatch relative input', async () => {
  const input = new Input();
  const controller = new PointerLockController(input, new Observer([
    { supported: true, locked: false, focused: true },
  ]));
  const degraded: string[] = [];
  const result = await controller.moveRelative({ x: 3, y: 1 }, {
    requirement: 'preferred',
    onDegraded: (event) => { degraded.push(event.status); },
  });

  assert.equal(result.status, 'degraded');
  assert.deepEqual(degraded, ['unavailable']);
  assert.deepEqual(input.events, []);
});

test('locked wrong owner fails closed without hiding actual lock state', async () => {
  const input = new Input();
  const controller = new PointerLockController(input, new Observer([
    { supported: true, locked: true, focused: true, owner: { backendNodeId: 99 } },
  ]));

  await assert.rejects(
    controller.moveRelative({ x: 1, y: 1 }, {
      requirement: 'required',
      owner: { backendNodeId: 7 },
    }),
    PointerLockRequiredError,
  );
  assert.equal(controller.current().phase, 'locked');
  assert.equal(controller.current().owner?.backendNodeId, 99);
  assert.deepEqual(input.events, []);
});

test('request failures stop at the configured attempt bound', async () => {
  const controller = new PointerLockController(new Input(), new Observer([]), {
    sleep: async () => {},
  });
  let attempts = 0;
  const result = await controller.acquire({
    request: async () => { attempts += 1; throw new Error('denied'); },
    maxAttempts: 4,
    pollsPerAttempt: 1,
    pollIntervalMs: 0,
  });

  assert.equal(result.status, 'request-rejected');
  assert.equal(attempts, 4);
});
