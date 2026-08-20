import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RealtimeSurfaceRuntime,
  runBoundedRealtimeCalibration,
  type RealtimeInput,
  type RealtimeMediaCommand,
  type RealtimeMediaControlResult,
  type RealtimeMediaState,
  type RealtimeSurfaceAdapter,
  type RealtimeSurfaceState,
  type RealtimeVisualCapture,
  type RealtimeVisualCaptureRequest,
} from '../src/computer/realtimeSurfaceRuntime.js';
import type { ComputerSurfaceRef } from '../src/computer/environmentAdapter.js';

const surface = { adapterId: 'fake-native', environment: 'desktop-ui', surfaceId: 'surface-1', generation: 3 } as const;

class FakeRealtimeAdapter implements RealtimeSurfaceAdapter {
  readonly descriptor = {
    adapterId: 'fake-native',
    environment: 'desktop-ui' as const,
    supportedInputs: ['keyboard', 'pointer', 'relative-pointer', 'wheel', 'controller'] as const,
    controllerControls: ['axis-x', 'button-a'] as const,
    media: {
      observePlayback: true,
      observePosition: true,
      observeDuration: true,
      setPlayback: true,
      setVolume: true,
      setMute: true,
      fullscreen: true,
    },
  };

  state: RealtimeSurfaceState = {
    surface: { ...surface },
    captureGeneration: 7,
    ownership: {
      focused: true,
      inputOwnerId: 'input-owner-1',
      captureOwnerId: 'capture-owner-1',
      sessionOwnerId: 'session-owner-1',
      rendererOwnerId: 'renderer-owner-1',
      deviceOwnerId: 'device-owner-1',
    },
    relativePointer: { active: false, generation: 1 },
  };
  inputs: RealtimeInput[] = [];
  sequence = 0;
  captures: Partial<RealtimeVisualCapture>[] = [];
  captureRequests: RealtimeVisualCaptureRequest[] = [];
  media: RealtimeMediaState = {
    surface: { ...surface },
    playback: 'paused',
    positionMs: 1_000,
    durationMs: 10_000,
    volume: 0.5,
    muted: false,
    fullscreen: { active: false },
  };

  async inspectSurface(_surface: ComputerSurfaceRef): Promise<RealtimeSurfaceState> {
    return structuredClone(this.state);
  }

  async captureVisual(request: RealtimeVisualCaptureRequest): Promise<RealtimeVisualCapture> {
    this.captureRequests.push(structuredClone(request));
    this.sequence += 1;
    const override = this.captures.shift();
    return {
      surface: { ...this.state.surface },
      captureGeneration: this.state.captureGeneration,
      frameId: `frame-${this.sequence}`,
      timestampMs: this.sequence * 10,
      sequence: this.sequence,
      width: 20,
      height: 10,
      byteLength: 800,
      droppedBefore: 0,
      truncated: false,
      data: `pixels-${this.sequence}`,
      ...override,
    };
  }

  async dispatchInput(_surface: ComputerSurfaceRef, input: RealtimeInput): Promise<void> {
    this.inputs.push(structuredClone(input));
  }

  async setRelativePointerCapture(_surface: ComputerSurfaceRef, active: boolean): Promise<RealtimeSurfaceState> {
    this.state.relativePointer = {
      active,
      generation: this.state.relativePointer.generation + 1,
      ownerId: active ? this.state.ownership.inputOwnerId : undefined,
    };
    return structuredClone(this.state);
  }

  async observeMedia(_surface: ComputerSurfaceRef): Promise<RealtimeMediaState> {
    return structuredClone(this.media);
  }

  async controlMedia(_surface: ComputerSurfaceRef, command: RealtimeMediaCommand): Promise<RealtimeMediaControlResult> {
    if (command.kind === 'playback') this.media.playback = command.state;
    if (command.kind === 'volume') this.media.volume = command.volume;
    if (command.kind === 'mute') this.media.muted = command.muted;
    return { localMediaEffect: 'applied', externalPublicationEffect: 'not-attempted', state: structuredClone(this.media) };
  }

  async setFullscreen(_surface: ComputerSurfaceRef, active: boolean, ownerId: string): Promise<RealtimeMediaState> {
    this.media.fullscreen = { active, ownerId: active ? ownerId : undefined };
    return structuredClone(this.media);
  }
}

const visual = { maxSamples: 2, limits: { maxPixels: 1_000, maxBytes: 5_000 } } as const;

test('surface and capture generations are part of the realtime lease identity', async () => {
  const adapter = new FakeRealtimeAdapter();
  const runtime = new RealtimeSurfaceRuntime(adapter);
  const lease = await runtime.acquire(surface);
  assert.equal(lease.surface.generation, 3);
  assert.equal(lease.captureGeneration, 7);

  adapter.state.captureGeneration += 1;
  await assert.rejects(runtime.observeVisual(lease, visual), (error: unknown) =>
    error instanceof Error && error.message.includes('capture generation changed'));
});

test('stale surface generation is rejected before input or capture', async () => {
  const adapter = new FakeRealtimeAdapter();
  const runtime = new RealtimeSurfaceRuntime(adapter);
  const lease = await runtime.acquire(surface);
  adapter.state.surface.generation += 1;

  await assert.rejects(runtime.dispatchInput(lease, { kind: 'keyboard', action: 'press', key: 'a' }), /surface generation changed/);
  assert.equal(adapter.inputs.length, 0);
});

test('focus, capture, session, renderer, and device ownership losses fail closed', async () => {
  const mutations: Array<(adapter: FakeRealtimeAdapter) => void> = [
    (adapter) => { adapter.state.ownership.focused = false; },
    (adapter) => { adapter.state.ownership.captureOwnerId = 'capture-owner-2'; },
    (adapter) => { adapter.state.ownership.sessionOwnerId = 'session-owner-2'; },
    (adapter) => { adapter.state.ownership.rendererOwnerId = 'renderer-owner-2'; },
    (adapter) => { adapter.state.ownership.deviceOwnerId = 'device-owner-2'; },
  ];
  for (const mutate of mutations) {
    const adapter = new FakeRealtimeAdapter();
    const runtime = new RealtimeSurfaceRuntime(adapter);
    const lease = await runtime.acquire(surface);
    mutate(adapter);
    await assert.rejects(runtime.dispatchInput(lease, { kind: 'wheel', deltaX: 0, deltaY: 1 }));
    assert.equal(adapter.inputs.length, 0);
  }
});

test('input support is adapter-declared, including controller controls', async () => {
  const adapter = new FakeRealtimeAdapter();
  const runtime = new RealtimeSurfaceRuntime(adapter);
  const lease = await runtime.acquire(surface);
  await runtime.dispatchInput(lease, { kind: 'controller', control: 'axis-x', value: 0.25 });
  await assert.rejects(runtime.dispatchInput(lease, { kind: 'controller', control: 'axis-y', value: 0.25 }), /does not declare controller control/);
  assert.deepEqual(adapter.inputs, [{ kind: 'controller', control: 'axis-x', value: 0.25 }]);
});

test('relative pointer movement has an explicit owned capture lifecycle', async () => {
  const adapter = new FakeRealtimeAdapter();
  const runtime = new RealtimeSurfaceRuntime(adapter);
  let lease = await runtime.acquire(surface);

  await assert.rejects(runtime.dispatchInput(lease, { kind: 'relative-pointer', dx: 2, dy: -1 }), /requires active capture/);
  lease = await runtime.setRelativePointerCapture(lease, true);
  await runtime.dispatchInput(lease, { kind: 'relative-pointer', dx: 2, dy: -1 });
  adapter.state.relativePointer.ownerId = 'someone-else';
  await assert.rejects(runtime.dispatchInput(lease, { kind: 'relative-pointer', dx: 1, dy: 1 }), /capture/);
  assert.deepEqual(adapter.inputs, [{ kind: 'relative-pointer', dx: 2, dy: -1 }]);
});

test('visual observation is bounded and preserves temporal/frame identity', async () => {
  const adapter = new FakeRealtimeAdapter();
  const runtime = new RealtimeSurfaceRuntime(adapter);
  const lease = await runtime.acquire(surface);
  const observed = await runtime.observeVisual(lease, {
    maxSamples: 2,
    bounds: { x: 10, y: 20, width: 20, height: 10 },
    limits: { maxPixels: 200, maxBytes: 1_000 },
  });

  assert.equal(observed.samples.length, 2);
  assert.deepEqual(observed.samples.map((sample) => [sample.order, sample.frameId, sample.timestampMs]), [
    [0, 'frame-1', 10],
    [1, 'frame-2', 20],
  ]);
  assert.equal(adapter.captureRequests.length, 2);
  assert.equal(adapter.captureRequests[0].limits.maxPixels, 200);
  await assert.rejects(runtime.observeVisual(lease, { maxSamples: 121, limits: { maxPixels: 1, maxBytes: 1 } }), /maxSamples/);
});

test('temporal observations surface dropped and truncated samples explicitly', async () => {
  const adapter = new FakeRealtimeAdapter();
  adapter.captures.push({ droppedBefore: 3 }, { droppedBefore: 1, truncated: true });
  const runtime = new RealtimeSurfaceRuntime(adapter);
  const lease = await runtime.acquire(surface);
  const observed = await runtime.observeVisual(lease, visual);

  assert.equal(observed.droppedSamples, 4);
  assert.equal(observed.truncated, true);
  assert.deepEqual(observed.samples.map((sample) => [sample.droppedBefore, sample.truncated]), [[3, false], [1, true]]);
});

test('out-of-order temporal captures are rejected', async () => {
  const adapter = new FakeRealtimeAdapter();
  adapter.captures.push({ timestampMs: 20, sequence: 2 }, { timestampMs: 10, sequence: 3 });
  const runtime = new RealtimeSurfaceRuntime(adapter);
  const lease = await runtime.acquire(surface);
  await assert.rejects(runtime.observeVisual(lease, visual), /nondecreasing timestamps/);
});

test('bounded calibration executes only explicit short candidates and requires consequential-key attestation', async () => {
  const adapter = new FakeRealtimeAdapter();
  const runtime = new RealtimeSurfaceRuntime(adapter);
  const lease = await runtime.acquire(surface);
  const sleeps: number[] = [];
  const result = await runBoundedRealtimeCalibration(runtime, lease, {
    candidates: [
      {
        id: 'look-right',
        inputs: [{ kind: 'pointer', action: 'move', x: 10, y: 10 }],
        probeDurationMs: 20,
        keyboardSafety: 'not-applicable',
      },
      {
        id: 'confirm-key',
        inputs: [{ kind: 'keyboard', action: 'press', key: 'Enter' }],
        probeDurationMs: 20,
        keyboardSafety: 'potentially-consequential',
      },
    ],
    samplesPerPhase: 1,
    visual: { limits: { maxPixels: 1_000, maxBytes: 5_000 } },
    maxActions: 4,
  }, { sleep: async (ms) => { sleeps.push(ms); } });

  assert.deepEqual(result.candidates.map((candidate) => [candidate.id, candidate.status, candidate.reason]), [
    ['look-right', 'observed', undefined],
    ['confirm-key', 'rejected', 'safety-attestation-required'],
  ]);
  assert.deepEqual(adapter.inputs, [{ kind: 'pointer', action: 'move', x: 10, y: 10 }]);
  assert.deepEqual(sleeps, [20]);
  assert.equal(result.actionsDispatched, 1);
});

test('bounded calibration honors explicit attestation and action budget without arbitrary exploration', async () => {
  const adapter = new FakeRealtimeAdapter();
  const runtime = new RealtimeSurfaceRuntime(adapter);
  const lease = await runtime.acquire(surface);
  const result = await runBoundedRealtimeCalibration(runtime, lease, {
    candidates: [
      {
        id: 'attested-enter',
        inputs: [{ kind: 'keyboard', action: 'down', key: 'Enter' }, { kind: 'keyboard', action: 'up', key: 'Enter' }],
        probeDurationMs: 0,
        keyboardSafety: 'potentially-consequential',
      },
      {
        id: 'budgeted-out',
        inputs: [{ kind: 'wheel', deltaX: 0, deltaY: 1 }],
        probeDurationMs: 0,
        keyboardSafety: 'not-applicable',
      },
    ],
    samplesPerPhase: 1,
    visual: { limits: { maxPixels: 1_000, maxBytes: 5_000 } },
    maxActions: 2,
    safetyAttestation: { purpose: 'bounded-control-calibration', consequentialCandidateIds: ['attested-enter'] },
  }, { sleep: async () => {} });

  assert.equal(result.actionsDispatched, 2);
  assert.equal(result.candidates[1].reason, 'action-budget-exhausted');
  assert.deepEqual(adapter.inputs.map((input) => input.kind), ['keyboard', 'keyboard']);
});

test('media state/control remains local and capability-gated', async () => {
  const adapter = new FakeRealtimeAdapter();
  const runtime = new RealtimeSurfaceRuntime(adapter);
  const lease = await runtime.acquire(surface);
  const observed = await runtime.observeMedia(lease);
  assert.equal(observed.playback, 'paused');
  assert.equal(observed.positionMs, 1_000);
  assert.equal(observed.durationMs, 10_000);

  const result = await runtime.controlMedia(lease, { kind: 'playback', state: 'playing' });
  assert.equal(result.localMediaEffect, 'applied');
  assert.equal(result.externalPublicationEffect, 'not-attempted');
  assert.equal(result.state?.playback, 'playing');
});

test('fullscreen can only be released by its current owner', async () => {
  const adapter = new FakeRealtimeAdapter();
  const runtime = new RealtimeSurfaceRuntime(adapter);
  const lease = await runtime.acquire(surface);
  const entered = await runtime.setFullscreen(lease, true);
  assert.equal(entered.fullscreen.ownerId, 'input-owner-1');

  adapter.media.fullscreen = { active: true, ownerId: 'external-owner' };
  await assert.rejects(runtime.setFullscreen(lease, false), /owned by another actor/);
  assert.equal(adapter.media.fullscreen.active, true);
});
