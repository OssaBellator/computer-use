import test from 'node:test';
import assert from 'node:assert/strict';
import { RealtimeControlLoop } from '../src/agent/realtimeControlLoop.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { Point } from '../src/types.js';

class Input implements BrowserInput {
  async movePointer(_point: Point): Promise<void> {}
  async pointerDown(_button: MouseButton = 'left'): Promise<void> {}
  async pointerUp(_button: MouseButton = 'left'): Promise<void> {}
  async pressKey(_key: string): Promise<void> {}
  async keyDown(_key: string): Promise<void> {}
  async keyUp(_key: string): Promise<void> {}
  async typeText(_text: string): Promise<void> {}
  async scroll(_delta: Point): Promise<void> {}
}

test('realtime loop can reuse one observation across faster control ticks', async () => {
  let now = 0;
  let observations = 0;
  const samples: Array<{
    tick: number;
    value: number;
    fresh: boolean;
    ageTicks: number;
    ageMs: number;
  }> = [];

  const result = await new RealtimeControlLoop(new Input(), {
    observe: async () => ++observations,
    decide: (sample) => {
      samples.push({
        tick: sample.tick,
        value: sample.observation,
        fresh: sample.observationFresh,
        ageTicks: sample.observationAgeTicks,
        ageMs: sample.observationAgeMs,
      });
      return sample.tick === 6 ? { stop: true, reason: 'enough' } : {};
    },
    tickIntervalMs: 5,
    observeEveryTicks: 3,
    maxTicks: 20,
    maxDurationMs: 100,
    now: () => now,
    sleep: async (ms) => { now += ms; },
  }).run();

  assert.equal(result.status, 'stopped');
  assert.equal(result.ticks, 7);
  assert.equal(observations, 3);
  assert.deepEqual(samples.map((sample) => sample.value), [1, 1, 1, 2, 2, 2, 3]);
  assert.deepEqual(samples.map((sample) => sample.fresh), [true, false, false, true, false, false, true]);
  assert.deepEqual(samples.map((sample) => sample.ageTicks), [0, 1, 2, 0, 1, 2, 0]);
  assert.deepEqual(samples.map((sample) => sample.ageMs), [0, 5, 10, 0, 5, 10, 0]);
});

test('observation cadence is validated before any input or observation work', () => {
  assert.throws(() => new RealtimeControlLoop(new Input(), {
    observe: async () => null,
    decide: () => ({}),
    observeEveryTicks: 0,
  }), /observeEveryTicks must be a positive integer/);
});
