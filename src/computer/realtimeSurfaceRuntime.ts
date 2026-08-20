import { sameComputerSurface, type ComputerEnvironmentKind, type ComputerSurfaceRef } from './environmentAdapter.js';

export const REALTIME_INPUT_KINDS = [
  'keyboard',
  'pointer',
  'relative-pointer',
  'wheel',
  'controller',
] as const;

export type RealtimeInputKind = typeof REALTIME_INPUT_KINDS[number];

export interface RealtimeSurfaceDescriptor {
  adapterId: string;
  environment: ComputerEnvironmentKind;
  supportedInputs: readonly RealtimeInputKind[];
  controllerControls?: readonly string[];
  media?: {
    observePlayback?: boolean;
    observePosition?: boolean;
    observeDuration?: boolean;
    setPlayback?: boolean;
    setVolume?: boolean;
    setMute?: boolean;
    fullscreen?: boolean;
  };
}

/**
 * All owner IDs are opaque adapter-issued capabilities. They are compared for
 * equality only and must never be synthesized from window titles or process names.
 */
export interface RealtimeInputOwnershipState {
  focused: boolean;
  inputOwnerId: string;
  captureOwnerId: string;
  sessionOwnerId: string;
  rendererOwnerId?: string;
  deviceOwnerId?: string;
}

export interface RelativePointerCaptureState {
  active: boolean;
  generation: number;
  ownerId?: string;
}

export interface RealtimeSurfaceState {
  surface: ComputerSurfaceRef & { generation: number };
  /** Increments when the adapter replaces/reconfigures the visual capture source. */
  captureGeneration: number;
  ownership: RealtimeInputOwnershipState;
  relativePointer: RelativePointerCaptureState;
}

export interface RealtimeSurfaceLease {
  surface: ComputerSurfaceRef & { generation: number };
  captureGeneration: number;
  ownership: RealtimeInputOwnershipState;
  relativePointerGeneration: number;
}

export interface RealtimeVisualBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface RealtimeVisualCaptureLimits {
  /** Hard caller bound; runtime also applies a global ceiling. */
  maxPixels: number;
  /** Hard caller bound for adapter-owned payload bytes. */
  maxBytes: number;
}

export interface RealtimeVisualCaptureRequest {
  surface: ComputerSurfaceRef & { generation: number };
  captureGeneration: number;
  bounds?: RealtimeVisualBounds;
  limits: RealtimeVisualCaptureLimits;
}

export interface RealtimeVisualCapture {
  surface: ComputerSurfaceRef & { generation: number };
  captureGeneration: number;
  frameId: string;
  timestampMs: number;
  sequence: number;
  width: number;
  height: number;
  byteLength: number;
  /** Number of adapter-known frames omitted before this capture. */
  droppedBefore: number;
  /** True when this individual frame was clipped/reduced to honor a bound. */
  truncated: boolean;
  data: unknown;
}

export interface RealtimeTemporalSample extends RealtimeVisualCapture {
  order: number;
}

export interface RealtimeTemporalObservation {
  surface: ComputerSurfaceRef & { generation: number };
  captureGeneration: number;
  samples: readonly RealtimeTemporalSample[];
  droppedSamples: number;
  truncated: boolean;
}

export interface RealtimeTemporalObservationRequest {
  maxSamples: number;
  bounds?: RealtimeVisualBounds;
  limits: RealtimeVisualCaptureLimits;
}

export type RealtimeKeyboardInput = {
  kind: 'keyboard';
  action: 'down' | 'up' | 'press';
  key: string;
};

export type RealtimePointerInput = {
  kind: 'pointer';
  action: 'move' | 'down' | 'up';
  x?: number;
  y?: number;
  button?: 'left' | 'middle' | 'right' | 'back' | 'forward';
};

export type RealtimeRelativePointerInput = {
  kind: 'relative-pointer';
  dx: number;
  dy: number;
};

export type RealtimeWheelInput = {
  kind: 'wheel';
  deltaX: number;
  deltaY: number;
};

export type RealtimeControllerInput = {
  kind: 'controller';
  control: string;
  value: number;
};

export type RealtimeInput =
  | RealtimeKeyboardInput
  | RealtimePointerInput
  | RealtimeRelativePointerInput
  | RealtimeWheelInput
  | RealtimeControllerInput;

export type RealtimePlaybackState = 'playing' | 'paused' | 'stopped' | 'buffering' | 'ended' | 'unknown';

export interface RealtimeFullscreenState {
  active: boolean;
  /** Adapter-issued owner of fullscreen, distinct from visual/input ownership. */
  ownerId?: string;
}

export interface RealtimeMediaState {
  surface: ComputerSurfaceRef & { generation: number };
  playback: RealtimePlaybackState;
  positionMs?: number;
  durationMs?: number;
  volume?: number;
  muted?: boolean;
  fullscreen: RealtimeFullscreenState;
}

export type RealtimeMediaCommand =
  | { kind: 'playback'; state: 'playing' | 'paused' | 'stopped' }
  | { kind: 'volume'; volume: number }
  | { kind: 'mute'; muted: boolean };

export interface RealtimeMediaControlResult {
  localMediaEffect: 'applied' | 'not-applied' | 'unknown';
  /** Local playback/control APIs never imply publication or streaming success. */
  externalPublicationEffect: 'not-attempted';
  state?: RealtimeMediaState;
}

export interface RealtimeSurfaceAdapter {
  readonly descriptor: RealtimeSurfaceDescriptor;
  inspectSurface(surface: ComputerSurfaceRef): Promise<RealtimeSurfaceState>;
  captureVisual(request: RealtimeVisualCaptureRequest): Promise<RealtimeVisualCapture>;
  dispatchInput(surface: ComputerSurfaceRef, input: RealtimeInput): Promise<void>;
  setRelativePointerCapture?(surface: ComputerSurfaceRef, active: boolean): Promise<RealtimeSurfaceState>;
  observeMedia?(surface: ComputerSurfaceRef): Promise<RealtimeMediaState>;
  controlMedia?(surface: ComputerSurfaceRef, command: RealtimeMediaCommand): Promise<RealtimeMediaControlResult>;
  setFullscreen?(surface: ComputerSurfaceRef, active: boolean, ownerId: string): Promise<RealtimeMediaState>;
}

export class RealtimeSurfaceError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RealtimeSurfaceError';
  }
}

const MAX_TEMPORAL_SAMPLES = 120;
const MAX_CAPTURE_PIXELS = 16_777_216;
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
const MAX_CALIBRATION_CANDIDATES = 16;
const MAX_CALIBRATION_INPUTS_PER_PROBE = 4;
const MAX_CALIBRATION_SAMPLES_PER_PHASE = 8;
const MAX_CALIBRATION_PROBE_MS = 250;
const MAX_CALIBRATION_ACTIONS = 64;

function validGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validFinite(value: number): boolean {
  return Number.isFinite(value);
}

function validPositiveSafeInteger(value: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= 1 && value <= max;
}

function requireOpaque(value: string, field: string): void {
  if (!value || /[\r\n\0]/.test(value) || new TextEncoder().encode(value).byteLength > 256) {
    throw new RealtimeSurfaceError('invalid-identity', `${field} must be a bounded opaque identifier`);
  }
}

function validateBounds(bounds: RealtimeVisualBounds | undefined, limits: RealtimeVisualCaptureLimits): void {
  if (!validPositiveSafeInteger(limits.maxPixels, MAX_CAPTURE_PIXELS)) {
    throw new RealtimeSurfaceError('invalid-visual-bound', `maxPixels must be between 1 and ${MAX_CAPTURE_PIXELS}`);
  }
  if (!validPositiveSafeInteger(limits.maxBytes, MAX_CAPTURE_BYTES)) {
    throw new RealtimeSurfaceError('invalid-visual-bound', `maxBytes must be between 1 and ${MAX_CAPTURE_BYTES}`);
  }
  if (!bounds) return;
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(validFinite) || bounds.width <= 0 || bounds.height <= 0) {
    throw new RealtimeSurfaceError('invalid-visual-bound', 'visual bounds must be finite with positive width and height');
  }
  if (Math.ceil(bounds.width) * Math.ceil(bounds.height) > limits.maxPixels) {
    throw new RealtimeSurfaceError('visual-bound-exceeded', 'requested visual region exceeds maxPixels');
  }
}

function assertDescriptorOwnsSurface(descriptor: RealtimeSurfaceDescriptor, surface: ComputerSurfaceRef): void {
  if (surface.adapterId !== descriptor.adapterId || surface.environment !== descriptor.environment) {
    throw new RealtimeSurfaceError('adapter-ownership-lost', 'surface is not owned by this realtime adapter/environment');
  }
}

function assertRealtimeSurfaceState(state: RealtimeSurfaceState, descriptor: RealtimeSurfaceDescriptor): void {
  assertDescriptorOwnsSurface(descriptor, state.surface);
  if (!validGeneration(state.surface.generation)) {
    throw new RealtimeSurfaceError('invalid-surface-generation', 'realtime surfaces require an explicit non-negative generation');
  }
  if (!validGeneration(state.captureGeneration)) {
    throw new RealtimeSurfaceError('invalid-capture-generation', 'captureGeneration must be a non-negative safe integer');
  }
  if (!validGeneration(state.relativePointer.generation)) {
    throw new RealtimeSurfaceError('invalid-relative-generation', 'relative pointer generation must be a non-negative safe integer');
  }
  requireOpaque(state.ownership.inputOwnerId, 'inputOwnerId');
  requireOpaque(state.ownership.captureOwnerId, 'captureOwnerId');
  requireOpaque(state.ownership.sessionOwnerId, 'sessionOwnerId');
  if (state.ownership.rendererOwnerId !== undefined) requireOpaque(state.ownership.rendererOwnerId, 'rendererOwnerId');
  if (state.ownership.deviceOwnerId !== undefined) requireOpaque(state.ownership.deviceOwnerId, 'deviceOwnerId');
  if (state.relativePointer.ownerId !== undefined) requireOpaque(state.relativePointer.ownerId, 'relativePointer.ownerId');
}

function ownershipMatches(expected: RealtimeInputOwnershipState, current: RealtimeInputOwnershipState): string | undefined {
  if (!current.focused) return 'focus-lost';
  if (expected.inputOwnerId !== current.inputOwnerId) return 'input-ownership-lost';
  if (expected.captureOwnerId !== current.captureOwnerId) return 'capture-ownership-lost';
  if (expected.sessionOwnerId !== current.sessionOwnerId) return 'session-ownership-lost';
  if (expected.rendererOwnerId !== current.rendererOwnerId) return 'renderer-ownership-lost';
  if (expected.deviceOwnerId !== current.deviceOwnerId) return 'device-ownership-lost';
  return undefined;
}

function validateInput(input: RealtimeInput): void {
  if (input.kind === 'keyboard') {
    requireOpaque(input.key, 'key');
    return;
  }
  if (input.kind === 'pointer') {
    if (input.action === 'move' && (!validFinite(input.x ?? NaN) || !validFinite(input.y ?? NaN))) {
      throw new RealtimeSurfaceError('invalid-input', 'absolute pointer movement requires finite x and y');
    }
    if ((input.action === 'down' || input.action === 'up') && !input.button) {
      throw new RealtimeSurfaceError('invalid-input', 'pointer button action requires a button');
    }
    return;
  }
  if (input.kind === 'relative-pointer') {
    if (!validFinite(input.dx) || !validFinite(input.dy)) throw new RealtimeSurfaceError('invalid-input', 'relative pointer delta must be finite');
    return;
  }
  if (input.kind === 'wheel') {
    if (!validFinite(input.deltaX) || !validFinite(input.deltaY)) throw new RealtimeSurfaceError('invalid-input', 'wheel delta must be finite');
    return;
  }
  requireOpaque(input.control, 'controller control');
  if (!validFinite(input.value) || input.value < -1 || input.value > 1) {
    throw new RealtimeSurfaceError('invalid-input', 'controller value must be finite and within [-1, 1]');
  }
}

function assertMediaState(state: RealtimeMediaState, lease: RealtimeSurfaceLease): void {
  if (!sameComputerSurface(state.surface, lease.surface)) {
    throw new RealtimeSurfaceError('stale-surface', 'media observation belongs to a stale or different surface generation');
  }
  if (state.positionMs !== undefined && (!validFinite(state.positionMs) || state.positionMs < 0)) {
    throw new RealtimeSurfaceError('invalid-media-state', 'positionMs must be finite and non-negative');
  }
  if (state.durationMs !== undefined && (!validFinite(state.durationMs) || state.durationMs < 0)) {
    throw new RealtimeSurfaceError('invalid-media-state', 'durationMs must be finite and non-negative');
  }
  if (state.volume !== undefined && (!validFinite(state.volume) || state.volume < 0 || state.volume > 1)) {
    throw new RealtimeSurfaceError('invalid-media-state', 'volume must be within [0, 1]');
  }
}

export class RealtimeSurfaceRuntime {
  constructor(readonly adapter: RealtimeSurfaceAdapter) {}

  async acquire(surface: ComputerSurfaceRef): Promise<RealtimeSurfaceLease> {
    assertDescriptorOwnsSurface(this.adapter.descriptor, surface);
    const state = await this.adapter.inspectSurface(surface);
    assertRealtimeSurfaceState(state, this.adapter.descriptor);
    if (!sameComputerSurface(surface, state.surface)) {
      throw new RealtimeSurfaceError('stale-surface', 'requested surface generation does not match adapter state');
    }
    if (!state.ownership.focused) {
      throw new RealtimeSurfaceError('focus-lost', 'input lease requires current surface focus');
    }
    return {
      surface: { ...state.surface },
      captureGeneration: state.captureGeneration,
      ownership: { ...state.ownership },
      relativePointerGeneration: state.relativePointer.generation,
    };
  }

  private async assertFresh(lease: RealtimeSurfaceLease, requireInputOwnership = false): Promise<RealtimeSurfaceState> {
    assertDescriptorOwnsSurface(this.adapter.descriptor, lease.surface);
    const state = await this.adapter.inspectSurface(lease.surface);
    assertRealtimeSurfaceState(state, this.adapter.descriptor);
    if (!sameComputerSurface(state.surface, lease.surface)) {
      throw new RealtimeSurfaceError('stale-surface', 'surface generation changed');
    }
    if (state.captureGeneration !== lease.captureGeneration) {
      throw new RealtimeSurfaceError('stale-capture', 'capture generation changed');
    }
    if (requireInputOwnership) {
      const loss = ownershipMatches(lease.ownership, state.ownership);
      if (loss) throw new RealtimeSurfaceError(loss, `realtime input rejected because ${loss}`);
    }
    return state;
  }

  async dispatchInput(lease: RealtimeSurfaceLease, input: RealtimeInput): Promise<void> {
    validateInput(input);
    if (!this.adapter.descriptor.supportedInputs.includes(input.kind)) {
      throw new RealtimeSurfaceError('unsupported-input', `adapter does not declare ${input.kind} input support`);
    }
    if (input.kind === 'controller') {
      const declared = this.adapter.descriptor.controllerControls;
      if (!declared?.includes(input.control)) {
        throw new RealtimeSurfaceError('unsupported-input', `adapter does not declare controller control ${input.control}`);
      }
    }
    const state = await this.assertFresh(lease, true);
    if (input.kind === 'relative-pointer') {
      if (!state.relativePointer.active || state.relativePointer.ownerId !== lease.ownership.inputOwnerId) {
        throw new RealtimeSurfaceError('relative-capture-lost', 'relative pointer input requires active capture owned by the input lease');
      }
      if (state.relativePointer.generation !== lease.relativePointerGeneration) {
        throw new RealtimeSurfaceError('relative-capture-lost', 'relative pointer capture generation changed');
      }
    }
    await this.adapter.dispatchInput(lease.surface, input);
  }

  async setRelativePointerCapture(lease: RealtimeSurfaceLease, active: boolean): Promise<RealtimeSurfaceLease> {
    if (!this.adapter.descriptor.supportedInputs.includes('relative-pointer') || !this.adapter.setRelativePointerCapture) {
      throw new RealtimeSurfaceError('unsupported-input', 'adapter does not declare relative pointer capture support');
    }
    const before = await this.assertFresh(lease, true);
    if (!active) {
      if (!before.relativePointer.active || before.relativePointer.ownerId !== lease.ownership.inputOwnerId) {
        throw new RealtimeSurfaceError('relative-capture-lost', 'cannot release relative pointer capture owned elsewhere');
      }
    }
    const after = await this.adapter.setRelativePointerCapture(lease.surface, active);
    assertRealtimeSurfaceState(after, this.adapter.descriptor);
    if (!sameComputerSurface(after.surface, lease.surface) || after.captureGeneration !== lease.captureGeneration) {
      throw new RealtimeSurfaceError('stale-surface', 'surface or capture generation changed during relative pointer transition');
    }
    const loss = ownershipMatches(lease.ownership, after.ownership);
    if (loss) throw new RealtimeSurfaceError(loss, `ownership changed during relative pointer transition: ${loss}`);
    if (after.relativePointer.active !== active) {
      throw new RealtimeSurfaceError('relative-capture-lost', 'adapter did not reach requested relative pointer capture state');
    }
    if (active && after.relativePointer.ownerId !== lease.ownership.inputOwnerId) {
      throw new RealtimeSurfaceError('relative-capture-lost', 'relative pointer capture was acquired by another owner');
    }
    return { ...lease, relativePointerGeneration: after.relativePointer.generation };
  }

  async observeVisual(lease: RealtimeSurfaceLease, request: RealtimeTemporalObservationRequest): Promise<RealtimeTemporalObservation> {
    if (!validPositiveSafeInteger(request.maxSamples, MAX_TEMPORAL_SAMPLES)) {
      throw new RealtimeSurfaceError('invalid-sample-bound', `maxSamples must be between 1 and ${MAX_TEMPORAL_SAMPLES}`);
    }
    validateBounds(request.bounds, request.limits);
    await this.assertFresh(lease, false);
    const samples: RealtimeTemporalSample[] = [];
    let droppedSamples = 0;
    let truncated = false;
    let previousTimestamp = -Infinity;
    let previousSequence = -1;
    const frameIds = new Set<string>();

    for (let order = 0; order < request.maxSamples; order += 1) {
      const capture = await this.adapter.captureVisual({
        surface: lease.surface,
        captureGeneration: lease.captureGeneration,
        bounds: request.bounds,
        limits: request.limits,
      });
      if (!sameComputerSurface(capture.surface, lease.surface)) {
        throw new RealtimeSurfaceError('stale-surface', 'visual capture belongs to a stale or different surface generation');
      }
      if (capture.captureGeneration !== lease.captureGeneration) {
        throw new RealtimeSurfaceError('stale-capture', 'visual capture generation changed');
      }
      requireOpaque(capture.frameId, 'frameId');
      if (frameIds.has(capture.frameId)) throw new RealtimeSurfaceError('duplicate-frame', 'frame identity repeated within one temporal observation');
      frameIds.add(capture.frameId);
      if (!validFinite(capture.timestampMs) || capture.timestampMs < previousTimestamp || !Number.isSafeInteger(capture.sequence) || capture.sequence <= previousSequence) {
        throw new RealtimeSurfaceError('temporal-ordering', 'visual captures must have nondecreasing timestamps and strictly increasing sequence numbers');
      }
      if (!Number.isSafeInteger(capture.droppedBefore) || capture.droppedBefore < 0) {
        throw new RealtimeSurfaceError('invalid-capture', 'droppedBefore must be a non-negative safe integer');
      }
      if (!validPositiveSafeInteger(capture.width, request.limits.maxPixels) || !validPositiveSafeInteger(capture.height, request.limits.maxPixels)) {
        throw new RealtimeSurfaceError('invalid-capture', 'capture dimensions must be positive bounded integers');
      }
      if (capture.width * capture.height > request.limits.maxPixels || !Number.isSafeInteger(capture.byteLength) || capture.byteLength < 0 || capture.byteLength > request.limits.maxBytes) {
        throw new RealtimeSurfaceError('visual-bound-exceeded', 'adapter capture exceeded caller bounds');
      }
      previousTimestamp = capture.timestampMs;
      previousSequence = capture.sequence;
      droppedSamples += capture.droppedBefore;
      truncated ||= capture.truncated;
      samples.push({ ...capture, order });
    }

    return {
      surface: { ...lease.surface },
      captureGeneration: lease.captureGeneration,
      samples,
      droppedSamples,
      truncated,
    };
  }

  async observeMedia(lease: RealtimeSurfaceLease): Promise<RealtimeMediaState> {
    if (!this.adapter.observeMedia || !this.adapter.descriptor.media?.observePlayback) {
      throw new RealtimeSurfaceError('unsupported-media', 'adapter does not declare media observation support');
    }
    await this.assertFresh(lease, false);
    const state = await this.adapter.observeMedia(lease.surface);
    assertMediaState(state, lease);
    const caps = this.adapter.descriptor.media;
    if (!caps.observePosition) state.positionMs = undefined;
    if (!caps.observeDuration) state.durationMs = undefined;
    return state;
  }

  async controlMedia(lease: RealtimeSurfaceLease, command: RealtimeMediaCommand): Promise<RealtimeMediaControlResult> {
    const caps = this.adapter.descriptor.media;
    const supported = command.kind === 'playback' ? caps?.setPlayback : command.kind === 'volume' ? caps?.setVolume : caps?.setMute;
    if (!supported || !this.adapter.controlMedia) {
      throw new RealtimeSurfaceError('unsupported-media', `adapter does not declare ${command.kind} control support`);
    }
    if (command.kind === 'volume' && (!validFinite(command.volume) || command.volume < 0 || command.volume > 1)) {
      throw new RealtimeSurfaceError('invalid-media-command', 'volume must be within [0, 1]');
    }
    await this.assertFresh(lease, true);
    const result = await this.adapter.controlMedia(lease.surface, command);
    if (result.externalPublicationEffect !== 'not-attempted') {
      throw new RealtimeSurfaceError('invalid-media-result', 'local media control must not claim external publication/streaming success');
    }
    if (result.state) assertMediaState(result.state, lease);
    return result;
  }

  async setFullscreen(lease: RealtimeSurfaceLease, active: boolean): Promise<RealtimeMediaState> {
    if (!this.adapter.descriptor.media?.fullscreen || !this.adapter.setFullscreen || !this.adapter.observeMedia) {
      throw new RealtimeSurfaceError('unsupported-media', 'adapter does not declare fullscreen observation/control support');
    }
    await this.assertFresh(lease, true);
    const before = await this.adapter.observeMedia(lease.surface);
    assertMediaState(before, lease);
    if (!active && before.fullscreen.active && before.fullscreen.ownerId !== lease.ownership.inputOwnerId) {
      throw new RealtimeSurfaceError('fullscreen-ownership-lost', 'cannot exit fullscreen owned by another actor');
    }
    const after = await this.adapter.setFullscreen(lease.surface, active, lease.ownership.inputOwnerId);
    assertMediaState(after, lease);
    if (after.fullscreen.active !== active) {
      throw new RealtimeSurfaceError('fullscreen-state-mismatch', 'adapter did not reach requested fullscreen state');
    }
    if (active && after.fullscreen.ownerId !== lease.ownership.inputOwnerId) {
      throw new RealtimeSurfaceError('fullscreen-ownership-lost', 'fullscreen was acquired by another actor');
    }
    return after;
  }
}

export interface RealtimeCalibrationCandidate {
  id: string;
  inputs: readonly RealtimeInput[];
  /** Deliberately short dwell between dispatch and post-observation. */
  probeDurationMs: number;
  /** Required declaration; potentially consequential keyboard probes need attestation. */
  keyboardSafety: 'not-applicable' | 'ordinary' | 'potentially-consequential';
}

export interface RealtimeCalibrationSafetyAttestation {
  purpose: 'bounded-control-calibration';
  /** Explicit candidate IDs only; this is not a wildcard autonomous exploration grant. */
  consequentialCandidateIds: readonly string[];
}

export interface RealtimeCalibrationPlan {
  candidates: readonly RealtimeCalibrationCandidate[];
  samplesPerPhase: number;
  visual: Omit<RealtimeTemporalObservationRequest, 'maxSamples'>;
  maxActions: number;
  safetyAttestation?: RealtimeCalibrationSafetyAttestation;
}

export interface RealtimeCalibrationCandidateResult {
  id: string;
  status: 'observed' | 'rejected';
  reason?: string;
  baseline?: RealtimeTemporalObservation;
  after?: RealtimeTemporalObservation;
}

export interface RealtimeCalibrationResult {
  candidates: readonly RealtimeCalibrationCandidateResult[];
  actionsDispatched: number;
  truncated: boolean;
}

function validateCalibrationPlan(plan: RealtimeCalibrationPlan): void {
  if (!validPositiveSafeInteger(plan.candidates.length, MAX_CALIBRATION_CANDIDATES)) {
    throw new RealtimeSurfaceError('calibration-bound', `candidate count must be between 1 and ${MAX_CALIBRATION_CANDIDATES}`);
  }
  if (!validPositiveSafeInteger(plan.samplesPerPhase, MAX_CALIBRATION_SAMPLES_PER_PHASE)) {
    throw new RealtimeSurfaceError('calibration-bound', `samplesPerPhase must be between 1 and ${MAX_CALIBRATION_SAMPLES_PER_PHASE}`);
  }
  if (!validPositiveSafeInteger(plan.maxActions, MAX_CALIBRATION_ACTIONS)) {
    throw new RealtimeSurfaceError('calibration-bound', `maxActions must be between 1 and ${MAX_CALIBRATION_ACTIONS}`);
  }
  const ids = new Set<string>();
  for (const candidate of plan.candidates) {
    requireOpaque(candidate.id, 'calibration candidate id');
    if (ids.has(candidate.id)) throw new RealtimeSurfaceError('calibration-bound', 'calibration candidate IDs must be unique');
    ids.add(candidate.id);
    if (!validPositiveSafeInteger(candidate.inputs.length, MAX_CALIBRATION_INPUTS_PER_PROBE)) {
      throw new RealtimeSurfaceError('calibration-bound', `each probe may contain at most ${MAX_CALIBRATION_INPUTS_PER_PROBE} explicit inputs`);
    }
    if (!Number.isSafeInteger(candidate.probeDurationMs) || candidate.probeDurationMs < 0 || candidate.probeDurationMs > MAX_CALIBRATION_PROBE_MS) {
      throw new RealtimeSurfaceError('calibration-bound', `probeDurationMs must be between 0 and ${MAX_CALIBRATION_PROBE_MS}`);
    }
    for (const input of candidate.inputs) validateInput(input);
    const hasKeyboard = candidate.inputs.some((input) => input.kind === 'keyboard');
    if (hasKeyboard && candidate.keyboardSafety === 'not-applicable') {
      throw new RealtimeSurfaceError('calibration-safety', 'keyboard candidates must declare ordinary or potentially-consequential safety');
    }
    if (!hasKeyboard && candidate.keyboardSafety !== 'not-applicable') {
      throw new RealtimeSurfaceError('calibration-safety', 'non-keyboard candidates must use keyboardSafety not-applicable');
    }
  }
}

export async function runBoundedRealtimeCalibration(
  runtime: RealtimeSurfaceRuntime,
  lease: RealtimeSurfaceLease,
  plan: RealtimeCalibrationPlan,
  options: { sleep?: (ms: number) => Promise<void> } = {},
): Promise<RealtimeCalibrationResult> {
  validateCalibrationPlan(plan);
  validateBounds(plan.visual.bounds, plan.visual.limits);
  const sleep = options.sleep ?? (async (ms: number) => { if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms)); });
  const results: RealtimeCalibrationCandidateResult[] = [];
  let actionsDispatched = 0;
  let truncated = false;

  for (const candidate of plan.candidates) {
    const baseline = await runtime.observeVisual(lease, { ...plan.visual, maxSamples: plan.samplesPerPhase });
    truncated ||= baseline.truncated;
    if (candidate.keyboardSafety === 'potentially-consequential') {
      const attested = plan.safetyAttestation?.purpose === 'bounded-control-calibration' &&
        plan.safetyAttestation.consequentialCandidateIds.includes(candidate.id);
      if (!attested) {
        results.push({ id: candidate.id, status: 'rejected', reason: 'safety-attestation-required', baseline });
        continue;
      }
    }
    if (actionsDispatched + candidate.inputs.length > plan.maxActions) {
      results.push({ id: candidate.id, status: 'rejected', reason: 'action-budget-exhausted', baseline });
      truncated = true;
      continue;
    }
    for (const input of candidate.inputs) {
      await runtime.dispatchInput(lease, input);
      actionsDispatched += 1;
    }
    await sleep(candidate.probeDurationMs);
    const after = await runtime.observeVisual(lease, { ...plan.visual, maxSamples: plan.samplesPerPhase });
    truncated ||= after.truncated;
    results.push({ id: candidate.id, status: 'observed', baseline, after });
  }

  return { candidates: results, actionsDispatched, truncated };
}
