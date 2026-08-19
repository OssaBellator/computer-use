import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeControlLoop } from '../src/agent/realtimeControlLoop.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { Point } from '../src/types.js';

class Input implements BrowserInput {
  readonly events: string[] = [];

  async movePointer(point: Point): Promise<void> {
    this.events.push(`move:${point.x},${point.y}`);
  }
  async pointerDown(button: MouseButton = 'left'): Promise<void> {
    this.events.push(`pointerDown:${button}`);
  }
  async pointerUp(button: MouseButton = 'left'): Promise<void> {
    this.events.push(`pointerUp:${button}`);
  }
  async pressKey(key: string): Promise<void> {
    this.events.push(`press:${key}`);
  }
  async keyDown(key: string): Promise<void> {
    this.events.push(`keyDown:${key}`);
  }
  async keyUp(key: string): Promise<void> {
    this.events.push(`keyUp:${key}`);
  }
  async typeText(text: string): Promise<void> {
    this.events.push(`type:${text}`);
  }
  async scroll(delta: Point): Promise<void> {
    this.events.push(`scroll:${delta.x},${delta.y}`);
  }
}

test('realtime loop diffs held controls instead of repeating keyDown', async () => {
  const input = new Input();
  let now = 0;
  const result = await new RealtimeControlLoop(input, {
    observe: async () => ({ now }),
    decide: ({ tick }) => {
      if (tick === 0) return { heldKeys: ['ArrowRight'], heldButtons: ['left'], pointer: { x: 10, y: 20 } };
      if (tick === 1) return { heldKeys: ['ArrowRight'], heldButtons: ['left'] };
      if (tick === 2) return { heldKeys: ['ArrowLeft'] };
      return { stop: true, reason: 'goal-reached' };
    },
    tickIntervalMs: 5,
    maxTicks: 10,
    maxDurationMs: 100,
    now: () => now,
    sleep: async (ms) => { now += ms; },
  }).run();

  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'goal-reached');
  assert.equal(result.ticks, 4);
  assert.deepEqual(input.events, [
    'move:10,20',
    'keyDown:ArrowRight',
    'pointerDown:left',
    'keyUp:ArrowRight',
    'pointerUp:left',
    'keyDown:ArrowLeft',
    'keyUp:ArrowLeft',
  ]);
});

test('realtime loop releases held keys and buttons when the policy throws', async () => {
  const input = new Input();
  let tick = 0;
  const loop = new RealtimeControlLoop(input, {
    observe: async () => tick,
    decide: () => {
      if (tick++ === 0) return { heldKeys: ['w'], heldButtons: ['right'] };
      throw new Error('policy failed');
    },
    tickIntervalMs: 0,
    maxTicks: 4,
    maxDurationMs: 100,
  });

  await assert.rejects(loop.run(), /policy failed/);
  assert.deepEqual(input.events, [
    'keyDown:w',
    'pointerDown:right',
    'pointerUp:right',
    'keyUp:w',
  ]);
});

test('tick budget is hard and cleanup runs after exhaustion', async () => {
  const input = new Input();
  let now = 0;
  const sleeps: number[] = [];
  const result = await new RealtimeControlLoop(input, {
    observe: async () => now,
    decide: () => ({ heldKeys: ['d'] }),
    tickIntervalMs: 5,
    maxTicks: 2,
    maxDurationMs: 100,
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  }).run();

  assert.equal(result.status, 'tick-budget-exhausted');
  assert.equal(result.ticks, 2);
  assert.deepEqual(sleeps, [5]);
  assert.deepEqual(input.events, ['keyDown:d', 'keyUp:d']);
});

test('time budget truncates the final sleep and stops before another observation', async () => {
  const input = new Input();
  let now = 0;
  let observations = 0;
  const sleeps: number[] = [];
  const result = await new RealtimeControlLoop(input, {
    observe: async () => { observations += 1; return observations; },
    decide: () => ({}),
    tickIntervalMs: 6,
    maxTicks: 20,
    maxDurationMs: 10,
    now: () => now,
    sleep: async (ms) => { sleeps.push(ms); now += ms; },
  }).run();

  assert.equal(result.status, 'time-budget-exhausted');
  assert.equal(result.ticks, 2);
  assert.equal(observations, 2);
  assert.deepEqual(sleeps, [6, 4]);
});

test('slow observation cannot dispatch a new intent after the wall-clock budget expires', async () => {
  const input = new Input();
  let now = 0;
  let decisions = 0;
  const result = await new RealtimeControlLoop(input, {
    observe: async () => { now = 11; return { ready: true }; },
    decide: () => { decisions += 1; return { heldKeys: ['ArrowRight'] }; },
    tickIntervalMs: 0,
    maxTicks: 10,
    maxDurationMs: 10,
    now: () => now,
  }).run();

  assert.equal(result.status, 'time-budget-exhausted');
  assert.equal(result.ticks, 0);
  assert.equal(decisions, 0);
  assert.deepEqual(input.events, []);
});

test('slow policy cannot dispatch a stale intent after the wall-clock budget expires', async () => {
  const input = new Input();
  let now = 0;
  const result = await new RealtimeControlLoop(input, {
    observe: async () => ({ ready: true }),
    decide: async () => { now = 11; return { heldKeys: ['ArrowRight'] }; },
    tickIntervalMs: 0,
    maxTicks: 10,
    maxDurationMs: 10,
    now: () => now,
  }).run();

  assert.equal(result.status, 'time-budget-exhausted');
  assert.equal(result.ticks, 0);
  assert.deepEqual(input.events, []);
});

test('invalid intents fail closed before dispatching new input', async () => {
  const input = new Input();
  const loop = new RealtimeControlLoop(input, {
    observe: async () => null,
    decide: () => ({ heldKeys: ['ArrowRight', ''], pointer: { x: 1, y: 2 } }),
    tickIntervalMs: 0,
    maxTicks: 1,
    maxDurationMs: 100,
  });

  await assert.rejects(loop.run(), /non-empty strings/);
  assert.deepEqual(input.events, []);
});
