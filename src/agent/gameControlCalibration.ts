import type { BrowserInput, MouseButton } from '../input/browserInput.js';
import type { Point, Rect } from '../types.js';

export type GameControlAxis = 'x' | 'y';
export type GameControlCandidate =
  | { kind: 'key'; key: string; holdMs?: number }
  | { kind: 'mouse-button'; button: MouseButton; holdMs?: number }
  | { kind: 'wheel'; axis: GameControlAxis; delta: number }
  | { kind: 'pointer-axis'; axis: GameControlAxis; delta: number };

export interface GameControlMotionTrackObservation {
  velocityPxPerSecond: Point;
  confidence: number;
}

export interface GameControlObservation {
  timestampMs: number;
  /** Acquired renderer identity/clip. Missing means calibration input is not allowed. */
  region?: { generation: number; clip: Rect };
  /** Visual baseline generation, when supplied by the game visual pipeline. */
  perceptionGeneration?: number;
  /** True when this observation establishes a new baseline rather than a comparable delta. */
  baselineReset?: boolean;
  compatible: boolean;
  changedPixelFraction?: number;
  meanAbsoluteDifference?: number;
  /** Coarse temporal motion tracks, not semantic object identities. */
  tracks: readonly GameControlMotionTrackObservation[];
}

/** Structural subset accepted from CdpGameVisualPipeline without importing CDP-specific classes. */
export interface GameVisualPipelineSampleLike {
  timestampMs: number;
  perceptionGeneration: number;
  baselineReset: boolean;
  lease: { generation: number; region?: { clip: Rect } };
  sample?: {
    difference: null | {
      compatible: boolean;
      changedPixelFraction: number;
      meanAbsoluteDifference: number;
    };
  };
  tracking?: { tracks: readonly GameControlMotionTrackObservation[] };
}

export function gameControlObservationFromVisualPipeline(
  sample: GameVisualPipelineSampleLike,
): GameControlObservation {
  const difference = sample.sample?.difference ?? null;
  return {
    timestampMs: sample.timestampMs,
    ...(sample.lease.region
      ? { region: { generation: sample.lease.generation, clip: { ...sample.lease.region.clip } } }
      : {}),
    perceptionGeneration: sample.perceptionGeneration,
    baselineReset: sample.baselineReset,
    compatible: difference?.compatible === true,
    ...(difference?.compatible
      ? {
        changedPixelFraction: difference.changedPixelFraction,
        meanAbsoluteDifference: difference.meanAbsoluteDifference,
      }
      : {}),
    tracks: (sample.tracking?.tracks ?? []).map((track) => ({
      velocityPxPerSecond: { ...track.velocityPxPerSecond },
      confidence: track.confidence,
    })),
  };
}

export type GameControlEffectVariable =
  | 'changed-pixel-fraction'
  | 'mean-absolute-difference'
  | 'track-count'
  | 'mean-track-speed-px-per-second'
  | 'mean-track-velocity-x-px-per-second'
  | 'mean-track-velocity-y-px-per-second';

export interface GameControlObservedEffect {
  variable: GameControlEffectVariable;
  baseline: number;
  after: number;
  delta: number;
  threshold: number;
  confidence: number;
  measurable: boolean;
}

export type GameControlProbeOutcome = 'effect' | 'no-measurable-effect' | 'inconclusive';
export type GameControlProbeReason =
  | 'missing-game-region'
  | 'unstable-game-region'
  | 'incompatible-visual-observations'
  | 'insufficient-observations'
  | 'realtime-context-inactive'
  | 'unsupported-control'
  | 'action-budget-exhausted'
  | 'time-budget-exhausted'
  | 'reset-failed'
  | 'observation-failed'
  | 'dispatch-failed';

export interface GameControlRelationship {
  control: GameControlCandidate;
  outcome: GameControlProbeOutcome;
  confidence: number;
  baselineSamples: number;
  afterSamples: number;
  regionGeneration?: number;
  perceptionGeneration?: number;
  effects: GameControlObservedEffect[];
  reason?: GameControlProbeReason;
}

export type GameControlCalibrationStatus =
  | 'complete'
  | 'probe-budget-exhausted'
  | 'action-budget-exhausted'
  | 'time-budget-exhausted'
  | 'stopped-on-error';

export interface GameControlCalibration {
  status: GameControlCalibrationStatus;
  relationships: GameControlRelationship[];
  probesAttempted: number;
  actionsDispatched: number;
  resetsPerformed: number;
  elapsedMs: number;
}

export interface GameControlEffectThresholds {
  changedPixelFraction: number;
  meanAbsoluteDifference: number;
  trackCount: number;
  meanTrackSpeedPxPerSecond: number;
  meanTrackVelocityPxPerSecond: number;
  baselineNoiseMultiplier: number;
}

export interface GameControlCalibrationOptions {
  candidates: readonly GameControlCandidate[];
  observe(): Promise<GameControlObservation>;
  /** Explicit caller gate proving the acquired region is in a realtime-control context. */
  isRealtimeContextActive(observation: GameControlObservation): boolean | Promise<boolean>;
  /** Optional caller-owned, known-safe reset/rebaseline hook run only between distinct probes. */
  resetBetweenProbes?(previous: GameControlCandidate, next: GameControlCandidate): Promise<void>;
  maxProbes?: number;
  maxActions?: number;
  maxDurationMs?: number;
  samplesPerWindow?: number;
  minSamplesPerWindow?: number;
  maxObservationAttemptsPerWindow?: number;
  observationIntervalMs?: number;
  settleAfterPointerMs?: number;
  maxHoldMs?: number;
  maxWheelDelta?: number;
  maxPointerDelta?: number;
  minTrackConfidence?: number;
  thresholds?: Partial<GameControlEffectThresholds>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

interface MetricVector {
  changedPixelFraction: number;
  meanAbsoluteDifference: number;
  trackCount: number;
  meanTrackSpeedPxPerSecond: number;
  meanTrackVelocityX: number;
  meanTrackVelocityY: number;
}
interface ObservationWindow {
  observations: GameControlObservation[];
  metrics: MetricVector[];
  regionGeneration?: number;
  perceptionGeneration?: number;
  reason?: GameControlProbeReason;
}

const DEFAULT_THRESHOLDS: GameControlEffectThresholds = {
  changedPixelFraction: 0.015,
  meanAbsoluteDifference: 4,
  trackCount: 1,
  meanTrackSpeedPxPerSecond: 20,
  meanTrackVelocityPxPerSecond: 18,
  baselineNoiseMultiplier: 2,
};
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}
function finiteNonNegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}
function positiveFinite(name: string, value: number): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be finite and positive`);
  return value;
}
function fraction(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be in [0,1]`);
  return value;
}
function cloneControl(control: GameControlCandidate): GameControlCandidate { return { ...control }; }
function identity(control: GameControlCandidate): string {
  if (control.kind === 'key') return `key:${control.key}`;
  if (control.kind === 'mouse-button') return `mouse-button:${control.button}`;
  return `${control.kind}:${control.axis}:${control.delta > 0 ? '+' : '-'}`;
}
function validateCandidate(control: GameControlCandidate, hold: number, wheel: number, pointer: number): void {
  if (control.kind === 'key') {
    if (!control.key || control.key.length > 64) throw new Error('key candidates require 1-64 characters');
    if (finiteNonNegative('key holdMs', control.holdMs ?? 40) > hold) throw new Error('key holdMs exceeds maxHoldMs');
    return;
  }
  if (control.kind === 'mouse-button') {
    if (!['left', 'middle', 'right'].includes(control.button)) throw new Error('unsupported mouse button');
    if (finiteNonNegative('mouse-button holdMs', control.holdMs ?? 40) > hold) {
      throw new Error('mouse-button holdMs exceeds maxHoldMs');
    }
    return;
  }
  if (control.axis !== 'x' && control.axis !== 'y') throw new Error('control axis must be x or y');
  if (!Number.isFinite(control.delta) || control.delta === 0) throw new Error(`${control.kind} delta must be finite and non-zero`);
  if (Math.abs(control.delta) > (control.kind === 'wheel' ? wheel : pointer)) {
    throw new Error(`${control.kind} delta exceeds configured bound`);
  }
}
function sameRect(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) < 0.01 && Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.width - b.width) < 0.01 && Math.abs(a.height - b.height) < 0.01;
}
function validRect(rect: Rect): boolean {
  return [rect.x, rect.y, rect.width, rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
}
function validObservation(value: GameControlObservation): boolean {
  if (!Number.isFinite(value.timestampMs) || value.timestampMs < 0) return false;
  if (value.region && (!Number.isInteger(value.region.generation) || value.region.generation < 1 || !validRect(value.region.clip))) return false;
  if (value.perceptionGeneration !== undefined && (!Number.isInteger(value.perceptionGeneration) || value.perceptionGeneration < 0)) return false;
  if (value.changedPixelFraction !== undefined && (!Number.isFinite(value.changedPixelFraction) || value.changedPixelFraction < 0 || value.changedPixelFraction > 1)) return false;
  if (value.meanAbsoluteDifference !== undefined && (!Number.isFinite(value.meanAbsoluteDifference) || value.meanAbsoluteDifference < 0 || value.meanAbsoluteDifference > 255)) return false;
  return value.tracks.every((track) =>
    Number.isFinite(track.velocityPxPerSecond.x) && Number.isFinite(track.velocityPxPerSecond.y) &&
    Number.isFinite(track.confidence) && track.confidence >= 0 && track.confidence <= 1);
}
function center(value: GameControlObservation): Point | undefined {
  const clip = value.region?.clip;
  return clip ? { x: clip.x + clip.width / 2, y: clip.y + clip.height / 2 } : undefined;
}
function metrics(value: GameControlObservation, minConfidence: number): MetricVector | undefined {
  if (!value.compatible || value.baselineReset || value.changedPixelFraction === undefined || value.meanAbsoluteDifference === undefined) return undefined;
  const tracks = value.tracks.filter((track) => track.confidence >= minConfidence);
  const weight = tracks.reduce((sum, track) => sum + Math.max(track.confidence, 0.0001), 0);
  const weighted = (select: (track: GameControlMotionTrackObservation) => number) =>
    weight > 0 ? tracks.reduce((sum, track) => sum + select(track) * Math.max(track.confidence, 0.0001), 0) / weight : 0;
  return {
    changedPixelFraction: value.changedPixelFraction,
    meanAbsoluteDifference: value.meanAbsoluteDifference,
    trackCount: tracks.length,
    meanTrackSpeedPxPerSecond: weighted((track) => Math.hypot(track.velocityPxPerSecond.x, track.velocityPxPerSecond.y)),
    meanTrackVelocityX: weighted((track) => track.velocityPxPerSecond.x),
    meanTrackVelocityY: weighted((track) => track.velocityPxPerSecond.y),
  };
}
function mean(values: readonly number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length); }
function deviation(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function effect(variable: GameControlEffectVariable, before: readonly number[], after: readonly number[], minimum: number, noiseMultiplier: number, quality: number): GameControlObservedEffect {
  const baseline = mean(before);
  const next = mean(after);
  const delta = next - baseline;
  const threshold = Math.max(minimum, deviation(before) * noiseMultiplier);
  const ratio = threshold > 0 ? Math.abs(delta) / threshold : (delta === 0 ? 0 : Number.POSITIVE_INFINITY);
  const measurable = ratio >= 1;
  const confidence = quality * (measurable ? clamp01(0.5 + (ratio - 1) * 0.25) : clamp01(1 - ratio * 0.75));
  return { variable, baseline, after: next, delta, threshold, confidence, measurable };
}
function actionCost(control: GameControlCandidate): number {
  return control.kind === 'key' || control.kind === 'mouse-button' ? 3 : 2; // center + down/up or center + actuation
}

/**
 * Bounded control-effect experiment for an already-acquired realtime game region.
 * It never discovers page semantics, plans gameplay, or synthesizes page-side events.
 */
export class GameControlCalibrator {
  private readonly candidates: GameControlCandidate[];
  private readonly maxProbes: number;
  private readonly maxActions: number;
  private readonly maxDurationMs: number;
  private readonly samplesPerWindow: number;
  private readonly minSamplesPerWindow: number;
  private readonly maxObservationAttemptsPerWindow: number;
  private readonly observationIntervalMs: number;
  private readonly settleAfterPointerMs: number;
  private readonly minTrackConfidence: number;
  private readonly thresholds: GameControlEffectThresholds;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private actionsDispatched = 0;
  private resetsPerformed = 0;

  constructor(private readonly input: BrowserInput, private readonly options: GameControlCalibrationOptions) {
    this.maxProbes = positiveInteger('maxProbes', options.maxProbes ?? 16);
    this.maxActions = positiveInteger('maxActions', options.maxActions ?? 48);
    this.maxDurationMs = finiteNonNegative('maxDurationMs', options.maxDurationMs ?? 5_000);
    this.samplesPerWindow = positiveInteger('samplesPerWindow', options.samplesPerWindow ?? 3);
    this.minSamplesPerWindow = positiveInteger('minSamplesPerWindow', options.minSamplesPerWindow ?? 2);
    this.maxObservationAttemptsPerWindow = positiveInteger('maxObservationAttemptsPerWindow', options.maxObservationAttemptsPerWindow ?? 5);
    if (this.minSamplesPerWindow > this.samplesPerWindow) throw new Error('minSamplesPerWindow cannot exceed samplesPerWindow');
    if (this.maxObservationAttemptsPerWindow < this.minSamplesPerWindow) throw new Error('maxObservationAttemptsPerWindow cannot be smaller than minSamplesPerWindow');
    this.observationIntervalMs = finiteNonNegative('observationIntervalMs', options.observationIntervalMs ?? 16);
    this.settleAfterPointerMs = finiteNonNegative('settleAfterPointerMs', options.settleAfterPointerMs ?? 16);
    const maxHoldMs = finiteNonNegative('maxHoldMs', options.maxHoldMs ?? 250);
    const maxWheelDelta = positiveFinite('maxWheelDelta', options.maxWheelDelta ?? 480);
    const maxPointerDelta = positiveFinite('maxPointerDelta', options.maxPointerDelta ?? 120);
    this.minTrackConfidence = fraction('minTrackConfidence', options.minTrackConfidence ?? 0.25);
    this.thresholds = { ...DEFAULT_THRESHOLDS, ...(options.thresholds ?? {}) };
    Object.entries(this.thresholds).forEach(([name, value]) => finiteNonNegative(name, value));
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => performance.now());

    const seen = new Set<string>();
    this.candidates = options.candidates.map((control) => {
      validateCandidate(control, maxHoldMs, maxWheelDelta, maxPointerDelta);
      const key = identity(control);
      if (seen.has(key)) throw new Error(`duplicate calibration control is not allowed: ${key}`);
      seen.add(key);
      return cloneControl(control);
    });
  }

  async run(): Promise<GameControlCalibration> {
    this.actionsDispatched = 0;
    this.resetsPerformed = 0;
    const startedAt = this.now();
    const relationships: GameControlRelationship[] = [];
    let status: GameControlCalibrationStatus = 'complete';
    const expired = () => this.now() - startedAt >= this.maxDurationMs;

    for (let index = 0; index < this.candidates.length; index += 1) {
      if (index >= this.maxProbes) { status = 'probe-budget-exhausted'; break; }
      if (expired()) { status = 'time-budget-exhausted'; break; }
      const control = this.candidates[index];

      if (index > 0 && this.options.resetBetweenProbes) {
        try { await this.options.resetBetweenProbes(this.candidates[index - 1], control); this.resetsPerformed += 1; }
        catch { relationships.push(this.inconclusive(control, 'reset-failed')); status = 'stopped-on-error'; break; }
        if (expired()) { relationships.push(this.inconclusive(control, 'time-budget-exhausted')); status = 'time-budget-exhausted'; break; }
      }
      if (this.actionsDispatched + actionCost(control) > this.maxActions) {
        relationships.push(this.inconclusive(control, 'action-budget-exhausted'));
        status = 'action-budget-exhausted';
        break;
      }
      if (control.kind === 'pointer-axis' && !this.input.movePointerBy) {
        relationships.push(this.inconclusive(control, 'unsupported-control'));
        continue;
      }

      let preflight: GameControlObservation;
      try { preflight = await this.options.observe(); }
      catch { relationships.push(this.inconclusive(control, 'observation-failed')); status = 'stopped-on-error'; break; }
      if (expired()) { relationships.push(this.inconclusive(control, 'time-budget-exhausted')); status = 'time-budget-exhausted'; break; }
      if (!validObservation(preflight) || !preflight.region) { relationships.push(this.inconclusive(control, 'missing-game-region')); continue; }
      if (!await this.contextActive(preflight)) { relationships.push(this.inconclusive(control, 'realtime-context-inactive')); continue; }

      const target = center(preflight);
      if (!target) { relationships.push(this.inconclusive(control, 'missing-game-region')); continue; }
      try { await this.input.movePointer(target); this.actionsDispatched += 1; }
      catch { relationships.push(this.inconclusive(control, 'dispatch-failed')); status = 'stopped-on-error'; break; }
      if (await this.sleepWithinBudget(this.settleAfterPointerMs, startedAt)) {
        relationships.push(this.inconclusive(control, 'time-budget-exhausted'));
        status = 'time-budget-exhausted';
        break;
      }

      const anchor: ObservationWindow = {
        observations: [preflight], metrics: [], regionGeneration: preflight.region.generation,
        perceptionGeneration: preflight.perceptionGeneration,
      };
      const baseline = await this.collectWindow(anchor, startedAt);
      if (baseline.reason) {
        relationships.push(this.inconclusive(control, baseline.reason, baseline.metrics.length, 0, baseline.regionGeneration, baseline.perceptionGeneration));
        if (baseline.reason === 'time-budget-exhausted') status = 'time-budget-exhausted';
        if (baseline.reason === 'observation-failed') status = 'stopped-on-error';
        if (status !== 'complete') break;
        continue;
      }
      const latest = baseline.observations.at(-1);
      if (!latest || !await this.contextActive(latest)) {
        relationships.push(this.inconclusive(control, latest ? 'realtime-context-inactive' : 'insufficient-observations', baseline.metrics.length, 0, baseline.regionGeneration, baseline.perceptionGeneration));
        continue;
      }
      if (expired()) { relationships.push(this.inconclusive(control, 'time-budget-exhausted', baseline.metrics.length, 0, baseline.regionGeneration, baseline.perceptionGeneration)); status = 'time-budget-exhausted'; break; }

      const dispatchReason = await this.dispatch(control, startedAt);
      if (dispatchReason) {
        relationships.push(this.inconclusive(control, dispatchReason, baseline.metrics.length, 0, baseline.regionGeneration, baseline.perceptionGeneration));
        status = dispatchReason === 'time-budget-exhausted' ? 'time-budget-exhausted' : 'stopped-on-error';
        break;
      }
      const after = await this.collectWindow(baseline, startedAt);
      if (after.reason) {
        relationships.push(this.inconclusive(control, after.reason, baseline.metrics.length, after.metrics.length, baseline.regionGeneration, baseline.perceptionGeneration));
        if (after.reason === 'time-budget-exhausted') status = 'time-budget-exhausted';
        if (after.reason === 'observation-failed') status = 'stopped-on-error';
        if (status !== 'complete') break;
        continue;
      }
      relationships.push(this.relationship(control, baseline, after));
    }

    return {
      status,
      relationships,
      probesAttempted: relationships.length,
      actionsDispatched: this.actionsDispatched,
      resetsPerformed: this.resetsPerformed,
      elapsedMs: Math.max(0, this.now() - startedAt),
    };
  }

  private async contextActive(observation: GameControlObservation): Promise<boolean> {
    try { return await this.options.isRealtimeContextActive(observation); }
    catch { return false; }
  }

  private async collectWindow(anchor: ObservationWindow, startedAt: number): Promise<ObservationWindow> {
    const observations: GameControlObservation[] = [];
    const collected: MetricVector[] = [];
    const regionGeneration = anchor.regionGeneration;
    const perceptionGeneration = anchor.perceptionGeneration;
    const clip = anchor.observations.at(-1)?.region?.clip;
    let sawIncompatible = false;

    for (let attempt = 0; attempt < this.maxObservationAttemptsPerWindow; attempt += 1) {
      if (this.now() - startedAt >= this.maxDurationMs) return { observations, metrics: collected, regionGeneration, perceptionGeneration, reason: 'time-budget-exhausted' };
      let observation: GameControlObservation;
      try { observation = await this.options.observe(); }
      catch { return { observations, metrics: collected, regionGeneration, perceptionGeneration, reason: 'observation-failed' }; }
      observations.push(observation);
      if (!validObservation(observation) || !observation.region) return { observations, metrics: collected, regionGeneration, perceptionGeneration, reason: 'missing-game-region' };
      if (regionGeneration === undefined || !clip || observation.region.generation !== regionGeneration || !sameRect(observation.region.clip, clip)) {
        return { observations, metrics: collected, regionGeneration, perceptionGeneration, reason: 'unstable-game-region' };
      }
      if (perceptionGeneration !== undefined && observation.perceptionGeneration !== undefined && observation.perceptionGeneration !== perceptionGeneration) {
        return { observations, metrics: collected, regionGeneration, perceptionGeneration, reason: 'unstable-game-region' };
      }
      const vector = metrics(observation, this.minTrackConfidence);
      if (vector) collected.push(vector); else sawIncompatible = true;
      if (collected.length >= this.samplesPerWindow) break;
      if (attempt + 1 < this.maxObservationAttemptsPerWindow && this.observationIntervalMs > 0 &&
          await this.sleepWithinBudget(this.observationIntervalMs, startedAt)) {
        return { observations, metrics: collected, regionGeneration, perceptionGeneration, reason: 'time-budget-exhausted' };
      }
    }
    if (collected.length < this.minSamplesPerWindow) {
      return { observations, metrics: collected, regionGeneration, perceptionGeneration, reason: sawIncompatible ? 'incompatible-visual-observations' : 'insufficient-observations' };
    }
    return { observations, metrics: collected, regionGeneration, perceptionGeneration };
  }

  private async dispatch(control: GameControlCandidate, startedAt: number): Promise<GameControlProbeReason | undefined> {
    if (this.now() - startedAt >= this.maxDurationMs) return 'time-budget-exhausted';
    try {
      if (control.kind === 'wheel') {
        await this.input.scroll(control.axis === 'x' ? { x: control.delta, y: 0 } : { x: 0, y: control.delta });
        this.actionsDispatched += 1;
        return;
      }
      if (control.kind === 'pointer-axis') {
        await this.input.movePointerBy!(control.axis === 'x' ? { x: control.delta, y: 0 } : { x: 0, y: control.delta });
        this.actionsDispatched += 1;
        return;
      }
      let down = false;
      try {
        if (control.kind === 'key') await this.input.keyDown(control.key); else await this.input.pointerDown(control.button);
        this.actionsDispatched += 1;
        down = true;
        if (await this.sleepWithinBudget(control.holdMs ?? 40, startedAt)) return 'time-budget-exhausted';
      } finally {
        if (down) {
          if (control.kind === 'key') await this.input.keyUp(control.key); else await this.input.pointerUp(control.button);
          this.actionsDispatched += 1;
        }
      }
      return;
    } catch { return 'dispatch-failed'; }
  }

  private relationship(control: GameControlCandidate, baseline: ObservationWindow, after: ObservationWindow): GameControlRelationship {
    const quality = Math.min(1, baseline.metrics.length / this.samplesPerWindow) * Math.min(1, after.metrics.length / this.samplesPerWindow);
    const before = (key: keyof MetricVector) => baseline.metrics.map((value) => value[key]);
    const next = (key: keyof MetricVector) => after.metrics.map((value) => value[key]);
    const build = (variable: GameControlEffectVariable, key: keyof MetricVector, threshold: number) =>
      effect(variable, before(key), next(key), threshold, this.thresholds.baselineNoiseMultiplier, quality);
    const effects = [
      build('changed-pixel-fraction', 'changedPixelFraction', this.thresholds.changedPixelFraction),
      build('mean-absolute-difference', 'meanAbsoluteDifference', this.thresholds.meanAbsoluteDifference),
      build('track-count', 'trackCount', this.thresholds.trackCount),
      build('mean-track-speed-px-per-second', 'meanTrackSpeedPxPerSecond', this.thresholds.meanTrackSpeedPxPerSecond),
      build('mean-track-velocity-x-px-per-second', 'meanTrackVelocityX', this.thresholds.meanTrackVelocityPxPerSecond),
      build('mean-track-velocity-y-px-per-second', 'meanTrackVelocityY', this.thresholds.meanTrackVelocityPxPerSecond),
    ];
    const measurable = effects.filter((value) => value.measurable);
    return {
      control: cloneControl(control),
      outcome: measurable.length ? 'effect' : 'no-measurable-effect',
      confidence: measurable.length ? Math.max(...measurable.map((value) => value.confidence)) : Math.min(...effects.map((value) => value.confidence)),
      baselineSamples: baseline.metrics.length,
      afterSamples: after.metrics.length,
      regionGeneration: baseline.regionGeneration,
      perceptionGeneration: baseline.perceptionGeneration,
      effects,
    };
  }

  private inconclusive(control: GameControlCandidate, reason: GameControlProbeReason, baselineSamples = 0, afterSamples = 0, regionGeneration?: number, perceptionGeneration?: number): GameControlRelationship {
    return {
      control: cloneControl(control), outcome: 'inconclusive', confidence: 0, baselineSamples, afterSamples,
      ...(regionGeneration === undefined ? {} : { regionGeneration }),
      ...(perceptionGeneration === undefined ? {} : { perceptionGeneration }),
      effects: [], reason,
    };
  }

  private async sleepWithinBudget(ms: number, startedAt: number): Promise<boolean> {
    const remaining = Math.max(0, this.maxDurationMs - (this.now() - startedAt));
    if (ms <= 0 || remaining <= 0) return remaining <= 0;
    await this.sleep(Math.min(ms, remaining));
    return this.now() - startedAt >= this.maxDurationMs;
  }
}
