import type { Rect } from '../types.js';
import type { CdpSessionLike } from './cdpIdentity.js';
import {
  CdpGameRegionLease,
  type GameRegionLeaseSnapshot,
} from './gameRegionLease.js';
import type { GameRegionLocatorOptions } from './gameRegionLocator.js';
import {
  CdpVisualObserver,
  type VisualCaptureOptions,
} from './visualObserver.js';
import {
  VisualMotionSampler,
  type VisualMotionSample,
  type VisualMotionSamplerOptions,
} from './visualDiff.js';
import {
  VisualMotionTracker,
  type VisualMotionTrackerOptions,
  type VisualMotionTrackingFrame,
} from './visualMotionTracker.js';

export type GameVisualPipelineStatus = 'missing' | 'baseline' | 'sampled';

export interface GameVisualPipelineOptions {
  region?: GameRegionLocatorOptions;
  /** Base capture options; clip and PNG format are controlled by the acquired game region/sampler. */
  capture?: Omit<VisualCaptureOptions, 'clip' | 'format'>;
  motion?: Omit<VisualMotionSamplerOptions, 'capture'>;
  tracking?: VisualMotionTrackerOptions;
}

export interface GameVisualPipelineSample {
  status: GameVisualPipelineStatus;
  timestampMs: number;
  /** Increments whenever clip/renderer changes force a new visual baseline. */
  perceptionGeneration: number;
  rendererGeneration: number;
  lease: GameRegionLeaseSnapshot;
  baselineReset: boolean;
  sample?: VisualMotionSample;
  tracking?: VisualMotionTrackingFrame;
}

export interface GameRegionLeasePipelineLike {
  acquire(options?: GameRegionLocatorOptions): Promise<GameRegionLeaseSnapshot>;
  refresh(options?: GameRegionLocatorOptions): Promise<GameRegionLeaseSnapshot>;
}

export interface VisualMotionSamplerPipelineLike {
  sample(): Promise<VisualMotionSample>;
}

export interface VisualMotionTrackerPipelineLike {
  reset(): void;
  update(sample: VisualMotionSample, timestampMs: number): VisualMotionTrackingFrame;
}

export interface GameVisualPipelineDependencies {
  lease?: GameRegionLeasePipelineLike;
  tracker?: VisualMotionTrackerPipelineLike;
  createSampler?: (clip: Rect) => VisualMotionSamplerPipelineLike;
}

function finiteNonNegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}

function sameRect(a: Rect | undefined, b: Rect | undefined): boolean {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 0.01 &&
    Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.width - b.width) < 0.01 &&
    Math.abs(a.height - b.height) < 0.01;
}

function cloneRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

/**
 * One-call game visual observation pipeline.
 *
 * It acquires/refreshes the likely renderer, rebuilds the cropped PNG motion
 * sampler only when renderer generation or clip changes, and resets temporal
 * association exactly at those visual-baseline boundaries.
 */
export class CdpGameVisualPipeline {
  private readonly regionOptions: GameRegionLocatorOptions;
  private readonly lease: GameRegionLeasePipelineLike;
  private readonly tracker: VisualMotionTrackerPipelineLike;
  private readonly createSampler: (clip: Rect) => VisualMotionSamplerPipelineLike;
  private sampler?: VisualMotionSamplerPipelineLike;
  private started = false;
  private activeRendererGeneration?: number;
  private activeClip?: Rect;
  private perceptionGeneration = 0;
  private lastTimestampMs?: number;

  constructor(
    session: CdpSessionLike,
    options: GameVisualPipelineOptions = {},
    dependencies: GameVisualPipelineDependencies = {},
  ) {
    this.regionOptions = { ...(options.region ?? {}) };
    this.lease = dependencies.lease ?? new CdpGameRegionLease(session);
    this.tracker = dependencies.tracker ?? new VisualMotionTracker(options.tracking);
    const observer = new CdpVisualObserver(session);
    this.createSampler = dependencies.createSampler ?? ((clip) => new VisualMotionSampler(observer, {
      ...(options.motion ?? {}),
      capture: {
        ...(options.capture ?? {}),
        clip,
      },
    }));
  }

  async sample(timestampMs: number): Promise<GameVisualPipelineSample> {
    finiteNonNegative('timestampMs', timestampMs);
    if (this.lastTimestampMs !== undefined && timestampMs < this.lastTimestampMs) {
      throw new Error('game visual timestamps must be non-decreasing');
    }

    const lease = this.started
      ? await this.lease.refresh(this.regionOptions)
      : await this.lease.acquire(this.regionOptions);
    this.started = true;

    if (!lease.region) {
      if (this.sampler) this.tracker.reset();
      this.sampler = undefined;
      this.activeRendererGeneration = undefined;
      this.activeClip = undefined;
      this.lastTimestampMs = timestampMs;
      return {
        status: 'missing',
        timestampMs,
        perceptionGeneration: this.perceptionGeneration,
        rendererGeneration: lease.generation,
        lease,
        baselineReset: false,
      };
    }

    const baselineReset =
      !this.sampler ||
      this.activeRendererGeneration !== lease.generation ||
      !sameRect(this.activeClip, lease.region.clip);
    let sampler = this.sampler;
    if (baselineReset) {
      sampler = this.createSampler(cloneRect(lease.region.clip));
      this.sampler = sampler;
      this.tracker.reset();
      this.activeRendererGeneration = lease.generation;
      this.activeClip = cloneRect(lease.region.clip);
      this.perceptionGeneration += 1;
    }
    if (!sampler) throw new Error('game visual sampler was not initialized');

    const visualSample = await sampler.sample();
    const tracking = this.tracker.update(visualSample, timestampMs);
    this.lastTimestampMs = timestampMs;
    return {
      status: baselineReset ? 'baseline' : 'sampled',
      timestampMs,
      perceptionGeneration: this.perceptionGeneration,
      rendererGeneration: lease.generation,
      lease,
      baselineReset,
      sample: visualSample,
      tracking,
    };
  }
}
