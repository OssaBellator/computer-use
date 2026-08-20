import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GameControlCalibrator,
  gameControlObservationFromVisualPipeline,
  type GameControlObservation,
} from '../src/agent/gameControlCalibration.js';
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

class InputWithoutRelative implements BrowserInput {
  readonly events: string[] = [];

  async movePointer(point: Point): Promise<void> { this.events.push(`move:${point.x},${point.y}`); }
  async pointerDown(button: MouseButton = 'left'): Promise<void> { this.events.push(`down:${button}`); }
  async pointerUp(button: MouseButton = 'left'): Promise<void> { this.events.push(`up:${button}`); }
  async pressKey(key: string): Promise<void> { this.events.push(`press:${key}`); }
  async keyDown(key: string): Promise<void> { this.events.push(`keyDown:${key}`); }
  async keyUp(key: string): Promise<void> { this.events.push(`keyUp:${key}`); }
  async typeText(text: string): Promise<void> { this.events.push(`type:${text}`); }
  async scroll(delta: Point): Promise<void> { this.events.push(`scroll:${delta.x},${delta.y}`); }
}

const clip = { x: 100, y: 50, width: 200, height: 100 };

function observation(
  changedPixelFraction: number,
  meanAbsoluteDifference: number,
  velocityX = 2,
  options: { regionGeneration?: number; perceptionGeneration?: number; compatible?: boolean } = {},
): GameControlObservation {
  return {
    timestampMs: 1,
    region: { generation: options.regionGeneration ?? 1, clip: { ...clip } },
    perceptionGeneration: options.perceptionGeneration ?? 1,
    compatible: options.compatible ?? true,
    changedPixelFraction,
    meanAbsoluteDifference,
    tracks: [{ velocityPxPerSecond: { x: velocityX, y: 0 }, confidence: 0.9 }],
  };
}

function queueObserver(values: GameControlObservation[]) {
  let index = 0;
  return async () => {
    const value = values[index++];
    if (!value) throw new Error(`observation queue exhausted at ${index}`);
    return value;
  };
}

function passiveWindow(): GameControlObservation[] {
  return [observation(0.009, 2.8, 1), observation(0.010, 3.0, 2), observation(0.011, 3.2, 3)];
}

function noEffectWindow(): GameControlObservation[] {
  return [observation(0.010, 3.0, 2), observation(0.011, 3.1, 2.5), observation(0.0105, 3.0, 3)];
}

function effectWindow(): GameControlObservation[] {
  return [observation(0.048, 11.5, 112), observation(0.052, 12.5, 120), observation(0.050, 12, 116)];
}

function deterministicClock() {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => { now += ms; },
  };
}

test('calibration attributes a measurable synthetic motion effect to one bounded key probe', async () => {
  const input = new Input();
  const clock = deterministicClock();
  const result = await new GameControlCalibrator(input, {
    candidates: [{ kind: 'key', key: 'ArrowRight', holdMs: 40 }],
    observe: queueObserver([observation(0, 0), ...passiveWindow(), ...effectWindow()]),
    isRealtimeContextActive: () => true,
    isKeyProbeSafe: () => true,
    now: clock.now,
    sleep: clock.sleep,
  }).run();

  assert.equal(result.status, 'complete');
  assert.equal(result.actionsDispatched, 3);
  assert.equal(result.relationships[0].outcome, 'effect');
  assert.ok(result.relationships[0].confidence >= 0.5);
  const xEffect = result.relationships[0].effects.find(
    (effect) => effect.variable === 'mean-track-velocity-x-px-per-second',
  );
  assert.equal(xEffect?.measurable, true);
  assert.ok((xEffect?.delta ?? 0) > 100);
  assert.deepEqual(input.events, [
    'move:200,100',
    'keyDown:ArrowRight',
    'keyUp:ArrowRight',
  ]);
});

test('stable compatible evidence distinguishes no measurable effect from inconclusive', async () => {
  const input = new Input();
  const clock = deterministicClock();
  const result = await new GameControlCalibrator(input, {
    candidates: [{ kind: 'wheel', axis: 'y', delta: 60 }],
    observe: queueObserver([observation(0, 0), ...passiveWindow(), ...noEffectWindow()]),
    isRealtimeContextActive: () => true,
    now: clock.now,
    sleep: clock.sleep,
  }).run();

  assert.equal(result.relationships[0].outcome, 'no-measurable-effect');
  assert.equal(result.relationships[0].reason, undefined);
  assert.ok(result.relationships[0].confidence > 0.5);
  assert.deepEqual(input.events, ['move:200,100', 'scroll:0,60']);
});

test('renderer/perception replacement after input is observation-inconclusive rather than no-effect', async () => {
  const input = new Input();
  const clock = deterministicClock();
  const unstable = observation(0.01, 3, 2, { perceptionGeneration: 2 });
  const result = await new GameControlCalibrator(input, {
    candidates: [{ kind: 'mouse-button', button: 'left', holdMs: 20 }],
    observe: queueObserver([observation(0, 0), ...passiveWindow(), unstable]),
    isRealtimeContextActive: () => true,
    now: clock.now,
    sleep: clock.sleep,
  }).run();

  assert.equal(result.status, 'complete');
  assert.equal(result.relationships[0].outcome, 'inconclusive');
  assert.equal(result.relationships[0].reason, 'unstable-game-region');
  assert.deepEqual(input.events, ['move:200,100', 'down:left', 'up:left']);
});

test('action budget is reserved before a key probe so partial destructive input is not dispatched', async () => {
  const input = new Input();
  let observations = 0;
  const result = await new GameControlCalibrator(input, {
    candidates: [{ kind: 'key', key: 'x' }],
    observe: async () => { observations += 1; return observation(0, 0); },
    isRealtimeContextActive: () => true,
    maxActions: 2,
  }).run();

  assert.equal(result.status, 'action-budget-exhausted');
  assert.equal(result.relationships[0].reason, 'action-budget-exhausted');
  assert.equal(result.actionsDispatched, 0);
  assert.equal(observations, 0);
  assert.deepEqual(input.events, []);
});

test('key probes fail closed when explicit key safety approval is absent', async () => {
  const input = new Input();
  const clock = deterministicClock();
  const result = await new GameControlCalibrator(input, {
    candidates: [{ kind: 'key', key: 'Enter' }],
    observe: queueObserver([observation(0, 0), ...passiveWindow()]),
    isRealtimeContextActive: () => true,
    now: clock.now,
    sleep: clock.sleep,
  }).run();

  assert.equal(result.status, 'complete');
  assert.equal(result.relationships[0].outcome, 'inconclusive');
  assert.equal(result.relationships[0].reason, 'key-probe-not-safe');
  assert.equal(result.relationships[0].baselineSamples, 3);
  assert.equal(result.actionsDispatched, 1);
  assert.deepEqual(input.events, ['move:200,100']);
});

test('key safety gate checks the latest baseline observation and can veto native dispatch', async () => {
  const input = new Input();
  const clock = deterministicClock();
  const baseline = passiveWindow();
  let checkedObservation: GameControlObservation | undefined;
  const result = await new GameControlCalibrator(input, {
    candidates: [{ kind: 'key', key: ' ' }],
    observe: queueObserver([observation(0, 0), ...baseline]),
    isRealtimeContextActive: () => true,
    isKeyProbeSafe: (control, latest) => {
      assert.equal(control.key, ' ');
      checkedObservation = latest;
      return false;
    },
    now: clock.now,
    sleep: clock.sleep,
  }).run();

  assert.strictEqual(checkedObservation, baseline[2]);
  assert.equal(result.status, 'complete');
  assert.equal(result.relationships[0].reason, 'key-probe-not-safe');
  assert.equal(result.actionsDispatched, 1);
  assert.deepEqual(input.events, ['move:200,100']);
});

test('reset hook runs once between probes and every probe gets a fresh baseline', async () => {
  const input = new Input();
  const clock = deterministicClock();
  let resets = 0;
  const first = [observation(0, 0), ...passiveWindow(), ...noEffectWindow()];
  const second = [observation(0, 0), ...passiveWindow(), ...effectWindow()];
  const result = await new GameControlCalibrator(input, {
    candidates: [{ kind: 'key', key: 'a', holdMs: 10 }, { kind: 'key', key: 'd', holdMs: 10 }],
    observe: queueObserver([...first, ...second]),
    isRealtimeContextActive: () => true,
    isKeyProbeSafe: () => true,
    resetBetweenProbes: async () => { resets += 1; },
    now: clock.now,
    sleep: clock.sleep,
  }).run();

  assert.equal(result.status, 'complete');
  assert.equal(result.relationships.length, 2);
  assert.equal(result.relationships[0].outcome, 'no-measurable-effect');
  assert.equal(result.relationships[1].outcome, 'effect');
  assert.equal(resets, 1);
  assert.equal(result.resetsPerformed, 1);
  assert.equal(result.actionsDispatched, 6);
});

test('relative pointer candidate is explicitly inconclusive when the input adapter lacks support', async () => {
  const input = new InputWithoutRelative();
  let observations = 0;
  const result = await new GameControlCalibrator(input, {
    candidates: [{ kind: 'pointer-axis', axis: 'x', delta: 20 }],
    observe: async () => { observations += 1; return observation(0, 0); },
    isRealtimeContextActive: () => true,
  }).run();

  assert.equal(result.status, 'complete');
  assert.equal(result.relationships[0].outcome, 'inconclusive');
  assert.equal(result.relationships[0].reason, 'unsupported-control');
  assert.equal(observations, 0);
  assert.deepEqual(input.events, []);
});


test('relative pointer axis dispatches through BrowserInput.movePointerBy from the acquired region', async () => {
  const input = new Input();
  const clock = deterministicClock();
  const result = await new GameControlCalibrator(input, {
    candidates: [{ kind: 'pointer-axis', axis: 'x', delta: 24 }],
    observe: queueObserver([observation(0, 0), ...passiveWindow(), ...noEffectWindow()]),
    isRealtimeContextActive: () => true,
    now: clock.now,
    sleep: clock.sleep,
  }).run();

  assert.equal(result.status, 'complete');
  assert.deepEqual(input.events, ['move:200,100', 'moveBy:24,0']);
});

test('time budget stops after bounded centering without dispatching the candidate control', async () => {
  const input = new Input();
  const clock = deterministicClock();
  const result = await new GameControlCalibrator(input, {
    candidates: [{ kind: 'key', key: 'w' }],
    observe: queueObserver([observation(0, 0)]),
    isRealtimeContextActive: () => true,
    maxDurationMs: 15,
    now: clock.now,
    sleep: clock.sleep,
  }).run();

  assert.equal(result.status, 'time-budget-exhausted');
  assert.equal(result.relationships[0].reason, 'time-budget-exhausted');
  assert.equal(result.actionsDispatched, 1);
  assert.deepEqual(input.events, ['move:200,100']);
});

test('visual-pipeline adapter preserves acquired region and coarse track observations', () => {
  const mapped = gameControlObservationFromVisualPipeline({
    timestampMs: 25,
    perceptionGeneration: 3,
    baselineReset: false,
    lease: { generation: 7, region: { clip } },
    sample: { difference: { compatible: true, changedPixelFraction: 0.2, meanAbsoluteDifference: 31 } },
    tracking: { tracks: [{ velocityPxPerSecond: { x: 9, y: -4 }, confidence: 0.8 }] },
  });

  assert.deepEqual(mapped.region, { generation: 7, clip });
  assert.equal(mapped.perceptionGeneration, 3);
  assert.equal(mapped.changedPixelFraction, 0.2);
  assert.deepEqual(mapped.tracks, [{ velocityPxPerSecond: { x: 9, y: -4 }, confidence: 0.8 }]);
});
