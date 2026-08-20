import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RealtimeInputDispatchError,
  RealtimeSurfaceRuntime,
  runBoundedRealtimeCalibration,
  type RealtimeInput,
  type RealtimeInputDispatchResult,
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
    adapterId: 'fake-native', environment: 'desktop-ui' as const,
    supportedInputs: ['keyboard', 'pointer', 'relative-pointer', 'wheel', 'controller'] as const,
    controllerControls: ['axis-x', 'button-a'] as const,
    media: { observePlayback: true, observePosition: true, observeDuration: true, setPlayback: true, setVolume: true, setMute: true, fullscreen: true },
  };
  state: RealtimeSurfaceState = {
    surface: { ...surface }, captureGeneration: 7,
    ownership: { focused: true, inputOwnerId: 'input-owner-1', captureOwnerId: 'capture-owner-1', sessionOwnerId: 'session-owner-1', rendererOwnerId: 'renderer-owner-1', deviceOwnerId: 'device-owner-1' },
    relativePointer: { active: false, generation: 1 },
  };
  inputs: RealtimeInput[] = [];
  sequence = 0;
  captures: Partial<RealtimeVisualCapture>[] = [];
  dispatchMode: 'ok' | 'not-dispatched' | 'unknown' | 'throw-after-emit' = 'ok';
  media: RealtimeMediaState = { surface: { ...surface }, playback: 'paused', positionMs: 1000, durationMs: 10000, volume: 0.5, muted: false, fullscreen: { active: false } };
  mediaReturn?: RealtimeMediaState;

  async inspectSurface(_surface: ComputerSurfaceRef): Promise<RealtimeSurfaceState> { return structuredClone(this.state); }
  async captureVisual(_request: RealtimeVisualCaptureRequest): Promise<RealtimeVisualCapture> {
    this.sequence += 1;
    const override = this.captures.shift();
    const data = new Uint8Array(800);
    return { surface: { ...this.state.surface }, captureGeneration: this.state.captureGeneration, frameId: `frame-${this.sequence}`, timestampMs: this.sequence * 10, sequence: this.sequence, width: 20, height: 10, byteLength: data.byteLength, droppedBefore: 0, truncated: false, data, ...override };
  }
  async dispatchInput(_surface: ComputerSurfaceRef, input: RealtimeInput): Promise<RealtimeInputDispatchResult> {
    if (this.dispatchMode === 'throw-after-emit') { this.inputs.push(structuredClone(input)); throw new Error('transport lost after native emission'); }
    if (this.dispatchMode === 'not-dispatched') return { dispatch: 'not-dispatched' };
    if (this.dispatchMode === 'unknown') return { dispatch: 'unknown' };
    this.inputs.push(structuredClone(input)); return { dispatch: 'dispatched-once' };
  }
  async setRelativePointerCapture(_surface: ComputerSurfaceRef, active: boolean): Promise<RealtimeSurfaceState> {
    this.state.relativePointer = { active, generation: this.state.relativePointer.generation + 1, ownerId: active ? this.state.ownership.inputOwnerId : undefined };
    return structuredClone(this.state);
  }
  async observeMedia(_surface: ComputerSurfaceRef): Promise<RealtimeMediaState> { return this.mediaReturn ?? structuredClone(this.media); }
  async controlMedia(_surface: ComputerSurfaceRef, command: RealtimeMediaCommand): Promise<RealtimeMediaControlResult> {
    if (command.kind === 'playback') this.media.playback = command.state;
    if (command.kind === 'volume') this.media.volume = command.volume;
    if (command.kind === 'mute') this.media.muted = command.muted;
    return { localMediaEffect: 'applied', externalPublicationEffect: 'not-attempted', state: structuredClone(this.media) };
  }
  async setFullscreen(_surface: ComputerSurfaceRef, active: boolean, ownerId: string): Promise<RealtimeMediaState> {
    this.media.fullscreen = { active, ownerId: active ? ownerId : undefined }; return structuredClone(this.media);
  }
}
const visual = { maxSamples: 2, limits: { maxPixels: 1000, maxBytes: 5000 } } as const;

test('surface and capture generation changes reject stale leases', async () => {
  const a = new FakeRealtimeAdapter(); const r = new RealtimeSurfaceRuntime(a); const l = await r.acquire(surface);
  a.state.captureGeneration++; await assert.rejects(r.observeVisual(l, visual), /capture generation changed/);
  a.state.captureGeneration = 7; a.state.surface.generation++; await assert.rejects(r.dispatchInput(l, { kind: 'keyboard', action: 'press', key: 'a' }), /surface generation changed/);
});

test('focus/input/capture/session/renderer/device ownership loss fails closed', async () => {
  const mutate = [
    (a: FakeRealtimeAdapter) => { a.state.ownership.focused = false; },
    (a: FakeRealtimeAdapter) => { a.state.ownership.inputOwnerId = 'other'; },
    (a: FakeRealtimeAdapter) => { a.state.ownership.captureOwnerId = 'other'; },
    (a: FakeRealtimeAdapter) => { a.state.ownership.sessionOwnerId = 'other'; },
    (a: FakeRealtimeAdapter) => { a.state.ownership.rendererOwnerId = 'other'; },
    (a: FakeRealtimeAdapter) => { a.state.ownership.deviceOwnerId = 'other'; },
  ];
  for (const m of mutate) { const a = new FakeRealtimeAdapter(); const r = new RealtimeSurfaceRuntime(a); const l = await r.acquire(surface); m(a); await assert.rejects(r.dispatchInput(l, { kind: 'wheel', deltaX: 0, deltaY: 1 })); assert.equal(a.inputs.length, 0); }
});

test('adapter-declared controller support and relative pointer lifecycle are enforced', async () => {
  const a = new FakeRealtimeAdapter(); const r = new RealtimeSurfaceRuntime(a); let l = await r.acquire(surface);
  await r.dispatchInput(l, { kind: 'controller', control: 'axis-x', value: 0.25 });
  await assert.rejects(r.dispatchInput(l, { kind: 'controller', control: 'axis-y', value: 0.25 }), /does not declare/);
  await assert.rejects(r.dispatchInput(l, { kind: 'relative-pointer', dx: 1, dy: 1 }), /requires active capture/);
  l = await r.setRelativePointerCapture(l, true); await r.dispatchInput(l, { kind: 'relative-pointer', dx: 2, dy: -1 });
  a.state.relativePointer.ownerId = 'other'; await assert.rejects(r.dispatchInput(l, { kind: 'relative-pointer', dx: 1, dy: 1 }), /capture/);
});

test('visual observation preserves temporal identity and reports dropped/truncated samples', async () => {
  const a = new FakeRealtimeAdapter(); a.captures.push({ droppedBefore: 3 }, { droppedBefore: 1, truncated: true });
  const r = new RealtimeSurfaceRuntime(a); const l = await r.acquire(surface); const o = await r.observeVisual(l, visual);
  assert.deepEqual(o.samples.map(s => [s.order, s.frameId, s.timestampMs]), [[0, 'frame-1', 10], [1, 'frame-2', 20]]);
  assert.equal(o.droppedSamples, 4); assert.equal(o.truncated, true);
});

test('out-of-order temporal captures are rejected', async () => {
  const a = new FakeRealtimeAdapter(); a.captures.push({ timestampMs: 20, sequence: 2 }, { timestampMs: 10, sequence: 3 });
  const r = new RealtimeSurfaceRuntime(a); const l = await r.acquire(surface); await assert.rejects(r.observeVisual(l, visual), /nondecreasing timestamps/);
});

test('visual byte bound validates actual byte-backed payload against malicious metadata', async () => {
  const a = new FakeRealtimeAdapter(); a.captures.push({ data: new Uint8Array(6000), byteLength: 1 });
  const r = new RealtimeSurfaceRuntime(a); const l = await r.acquire(surface);
  await assert.rejects(r.observeVisual(l, { maxSamples: 1, limits: { maxPixels: 1000, maxBytes: 5000 } }), /misreported payload size/);
});

test('visual capture rejects unstructured non-byte payload even from a malicious typed adapter', async () => {
  const a = new FakeRealtimeAdapter(); a.captures.push({ data: { giant: new Array(10000).fill('x') } as unknown as Uint8Array, byteLength: 1 });
  const r = new RealtimeSurfaceRuntime(a); const l = await r.acquire(surface); await assert.rejects(r.observeVisual(l, { maxSamples: 1, limits: { maxPixels: 1000, maxBytes: 5000 } }), /Uint8Array/);
});

test('all keyboard calibration probes require candidate-scoped attestation regardless of caller classification', async () => {
  const a = new FakeRealtimeAdapter(); const r = new RealtimeSurfaceRuntime(a); const l = await r.acquire(surface);
  const result = await runBoundedRealtimeCalibration(r, l, {
    candidates: [{ id: 'misclassified-enter', inputs: [{ kind: 'keyboard', action: 'press', key: 'Enter' }], probeDurationMs: 10, keyboardSafety: 'ordinary' }],
    samplesPerPhase: 1, visual: { limits: { maxPixels: 1000, maxBytes: 5000 } }, maxActions: 2,
  }, { sleep: async () => {} });
  assert.equal(result.candidates[0].reason, 'safety-attestation-required'); assert.equal(a.inputs.length, 0);
});

test('attested keyboard calibration remains bounded by action budget', async () => {
  const a = new FakeRealtimeAdapter(); const r = new RealtimeSurfaceRuntime(a); const l = await r.acquire(surface);
  const result = await runBoundedRealtimeCalibration(r, l, {
    candidates: [
      { id: 'enter', inputs: [{ kind: 'keyboard', action: 'down', key: 'Enter' }, { kind: 'keyboard', action: 'up', key: 'Enter' }], probeDurationMs: 0, keyboardSafety: 'ordinary' },
      { id: 'extra', inputs: [{ kind: 'wheel', deltaX: 0, deltaY: 1 }], probeDurationMs: 0, keyboardSafety: 'not-applicable' },
    ], samplesPerPhase: 1, visual: { limits: { maxPixels: 1000, maxBytes: 5000 } }, maxActions: 2,
    safetyAttestation: { purpose: 'bounded-control-calibration', consequentialCandidateIds: ['enter'] },
  }, { sleep: async () => {} });
  assert.equal(result.actionsDispatched, 2); assert.equal(result.candidates[1].reason, 'action-budget-exhausted');
});

test('native input adapter exception is surfaced as unknown dispatch and not retry-safe', async () => {
  const a = new FakeRealtimeAdapter(); a.dispatchMode = 'throw-after-emit'; const r = new RealtimeSurfaceRuntime(a); const l = await r.acquire(surface);
  await assert.rejects(r.dispatchInput(l, { kind: 'keyboard', action: 'press', key: 'a' }), (error: unknown) => error instanceof RealtimeInputDispatchError && error.dispatch === 'unknown');
  assert.equal(a.inputs.length, 1);
});

test('adapter can explicitly report not-dispatched without pretending success', async () => {
  const a = new FakeRealtimeAdapter(); a.dispatchMode = 'not-dispatched'; const r = new RealtimeSurfaceRuntime(a); const l = await r.acquire(surface);
  assert.deepEqual(await r.dispatchInput(l, { kind: 'keyboard', action: 'press', key: 'a' }), { dispatch: 'not-dispatched' }); assert.equal(a.inputs.length, 0);
});

test('observeMedia sanitizes a copy and never mutates frozen/shared adapter state', async () => {
  const a = new FakeRealtimeAdapter();
  (a.descriptor.media as { observePosition?: boolean; observeDuration?: boolean }).observePosition = false;
  (a.descriptor.media as { observePosition?: boolean; observeDuration?: boolean }).observeDuration = false;
  const shared = Object.freeze({ ...a.media, surface: Object.freeze({ ...a.media.surface }), fullscreen: Object.freeze({ ...a.media.fullscreen }) }) as RealtimeMediaState;
  a.mediaReturn = shared;
  const r = new RealtimeSurfaceRuntime(a); const l = await r.acquire(surface); const observed = await r.observeMedia(l);
  assert.equal(observed.positionMs, undefined); assert.equal(observed.durationMs, undefined); assert.equal(shared.positionMs, 1000); assert.equal(shared.durationMs, 10000); assert.notStrictEqual(observed, shared);
});

test('media control remains local and fullscreen release preserves ownership', async () => {
  const a = new FakeRealtimeAdapter(); const r = new RealtimeSurfaceRuntime(a); const l = await r.acquire(surface);
  const result = await r.controlMedia(l, { kind: 'playback', state: 'playing' }); assert.equal(result.externalPublicationEffect, 'not-attempted');
  const entered = await r.setFullscreen(l, true); assert.equal(entered.fullscreen.ownerId, 'input-owner-1');
  a.media.fullscreen = { active: true, ownerId: 'external-owner' }; await assert.rejects(r.setFullscreen(l, false), /owned by another actor/);
});
