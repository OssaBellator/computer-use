import type { Point, Rect } from '../types.js';
import type { VisualDifferenceTile, VisualMotionSample } from './visualDiff.js';

export type VisualMotionCoordinateSpace = 'image' | 'viewport';

export interface VisualMotionRegion {
  rect: Rect;
  tileCount: number;
}

export interface VisualMotionTrack {
  id: number;
  coordinateSpace: VisualMotionCoordinateSpace;
  rect: Rect;
  center: Point;
  velocityPxPerSecond: Point;
  confidence: number;
  ageSamples: number;
  missedSamples: number;
  lastSeenSequence: number;
  lastSeenAtMs: number;
}

export interface VisualMotionTrackerOptions {
  /** Maximum changed tiles clustered directly. Larger inputs collapse to one motion bound. */
  maxChangedTiles?: number;
  /** Maximum connected motion regions retained per sample. */
  maxRegions?: number;
  /** Maximum live tracks retained. */
  maxTracks?: number;
  /** Maximum consecutive compatible samples a track may miss. */
  maxMissedSamples?: number;
  /** Maximum predicted-center distance for non-overlapping association. */
  maxAssociationDistancePx?: number;
  /** Gap allowed when merging neighboring changed tiles into one region. */
  mergeGapPx?: number;
  /** Measurement weight used to smooth velocity in [0,1]. */
  velocityAlpha?: number;
  /** Initial confidence for a new track in [0,1]. */
  initialConfidence?: number;
  /** Confidence added after a matched observation. */
  confidenceGain?: number;
  /** Confidence removed after a missed observation. */
  confidenceDecay?: number;
  /** Maximum horizon used for association prediction and public projection. */
  maxProjectionMs?: number;
}

export interface VisualMotionTrackingFrame {
  sequence: number;
  timestampMs: number;
  coordinateSpace?: VisualMotionCoordinateSpace;
  regions: VisualMotionRegion[];
  tracks: VisualMotionTrack[];
  /** True when excessive changed-tile input was collapsed to a single coarse bound. */
  collapsedInput: boolean;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function nonNegativeInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
  return value;
}

function finiteNonNegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be finite and non-negative`);
  return value;
}

function fraction(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be in [0,1]`);
  return value;
}

function cloneRect(rect: Rect): Rect {
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function center(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function area(rect: Rect): number {
  return Math.max(0, rect.width) * Math.max(0, rect.height);
}

function unionRect(a: Rect, b: Rect): Rect {
  const left = Math.min(a.x, b.x);
  const top = Math.min(a.y, b.y);
  const right = Math.max(a.x + a.width, b.x + b.width);
  const bottom = Math.max(a.y + a.height, b.y + b.height);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function connected(a: Rect, b: Rect, gap: number): boolean {
  return a.x <= b.x + b.width + gap &&
    a.x + a.width + gap >= b.x &&
    a.y <= b.y + b.height + gap &&
    a.y + a.height + gap >= b.y;
}

function intersectionOverUnion(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  if (right <= left || bottom <= top) return 0;
  const intersection = (right - left) * (bottom - top);
  const total = area(a) + area(b) - intersection;
  return total > 0 ? intersection / total : 0;
}

function shifted(rect: Rect, delta: Point): Rect {
  return { x: rect.x + delta.x, y: rect.y + delta.y, width: rect.width, height: rect.height };
}

function cloneTrack(track: VisualMotionTrack): VisualMotionTrack {
  return {
    ...track,
    rect: cloneRect(track.rect),
    center: { ...track.center },
    velocityPxPerSecond: { ...track.velocityPxPerSecond },
  };
}

function coordinateSpaceForTiles(
  tiles: readonly VisualDifferenceTile[],
  fallback: VisualMotionCoordinateSpace | undefined,
): VisualMotionCoordinateSpace {
  if (tiles.length > 0 && tiles.every((tile) => tile.viewportRect !== undefined)) return 'viewport';
  if (tiles.length > 0) return 'image';
  return fallback ?? 'image';
}

function tileRect(tile: VisualDifferenceTile, space: VisualMotionCoordinateSpace): Rect {
  return space === 'viewport' && tile.viewportRect ? tile.viewportRect : tile.imageRect;
}

function clusterTiles(
  tiles: readonly VisualDifferenceTile[],
  space: VisualMotionCoordinateSpace,
  mergeGapPx: number,
): VisualMotionRegion[] {
  const pending = tiles
    .map((tile) => cloneRect(tileRect(tile, space)))
    .sort((a, b) => a.y - b.y || a.x - b.x || a.width - b.width || a.height - b.height);
  const visited = new Array(pending.length).fill(false);
  const regions: VisualMotionRegion[] = [];

  for (let start = 0; start < pending.length; start += 1) {
    if (visited[start]) continue;
    visited[start] = true;
    const queue = [start];
    let rect = cloneRect(pending[start]);
    let tileCount = 0;
    for (let cursor = 0; cursor < queue.length; cursor += 1) {
      const index = queue[cursor];
      tileCount += 1;
      rect = unionRect(rect, pending[index]);
      for (let candidate = 0; candidate < pending.length; candidate += 1) {
        if (visited[candidate]) continue;
        if (!connected(pending[index], pending[candidate], mergeGapPx)) continue;
        visited[candidate] = true;
        queue.push(candidate);
      }
    }
    regions.push({ rect, tileCount });
  }
  return regions;
}

/** Project a track over a short bounded horizon using its latest smoothed velocity. */
export function projectVisualMotionTrack(
  track: VisualMotionTrack,
  horizonMs: number,
  maxProjectionMs = 250,
): Rect {
  finiteNonNegative('horizonMs', horizonMs);
  const maxHorizon = finiteNonNegative('maxProjectionMs', maxProjectionMs);
  const boundedMs = Math.min(horizonMs, maxHorizon);
  return shifted(track.rect, {
    x: track.velocityPxPerSecond.x * boundedMs / 1000,
    y: track.velocityPxPerSecond.y * boundedMs / 1000,
  });
}

/**
 * Bounded temporal tracker for coarse visual-change regions.
 *
 * Tracks describe connected screenshot-difference regions, not semantic game
 * entities. Association uses short-horizon velocity prediction plus overlap and
 * center distance. Excessive tile input collapses to one coarse motion bound so
 * per-sample work remains bounded.
 */
export class VisualMotionTracker {
  private readonly maxChangedTiles: number;
  private readonly maxRegions: number;
  private readonly maxTracks: number;
  private readonly maxMissedSamples: number;
  private readonly maxAssociationDistancePx: number;
  private readonly mergeGapPx: number;
  private readonly velocityAlpha: number;
  private readonly initialConfidence: number;
  private readonly confidenceGain: number;
  private readonly confidenceDecay: number;
  private readonly maxProjectionMs: number;
  private liveTracks: VisualMotionTrack[] = [];
  private nextTrackId = 1;
  private coordinateSpace?: VisualMotionCoordinateSpace;
  private lastSequence?: number;
  private lastTimestampMs?: number;

  constructor(options: VisualMotionTrackerOptions = {}) {
    this.maxChangedTiles = positiveInteger('maxChangedTiles', options.maxChangedTiles ?? 512);
    this.maxRegions = positiveInteger('maxRegions', options.maxRegions ?? 32);
    this.maxTracks = positiveInteger('maxTracks', options.maxTracks ?? 32);
    this.maxMissedSamples = nonNegativeInteger('maxMissedSamples', options.maxMissedSamples ?? 2);
    this.maxAssociationDistancePx = finiteNonNegative(
      'maxAssociationDistancePx', options.maxAssociationDistancePx ?? 96,
    );
    this.mergeGapPx = finiteNonNegative('mergeGapPx', options.mergeGapPx ?? 0);
    this.velocityAlpha = fraction('velocityAlpha', options.velocityAlpha ?? 0.6);
    this.initialConfidence = fraction('initialConfidence', options.initialConfidence ?? 0.5);
    this.confidenceGain = fraction('confidenceGain', options.confidenceGain ?? 0.2);
    this.confidenceDecay = fraction('confidenceDecay', options.confidenceDecay ?? 0.25);
    this.maxProjectionMs = finiteNonNegative('maxProjectionMs', options.maxProjectionMs ?? 250);
  }

  reset(): void {
    this.liveTracks = [];
    this.coordinateSpace = undefined;
    this.lastSequence = undefined;
    this.lastTimestampMs = undefined;
  }

  tracks(): VisualMotionTrack[] {
    return this.liveTracks.map(cloneTrack).sort((a, b) => a.id - b.id);
  }

  update(sample: VisualMotionSample, timestampMs: number): VisualMotionTrackingFrame {
    if (!Number.isInteger(sample.sequence) || sample.sequence < 1) {
      throw new Error('sample sequence must be a positive integer');
    }
    finiteNonNegative('timestampMs', timestampMs);
    if (this.lastSequence !== undefined && sample.sequence <= this.lastSequence) {
      throw new Error('visual motion samples must have strictly increasing sequence numbers');
    }
    if (this.lastTimestampMs !== undefined && timestampMs < this.lastTimestampMs) {
      throw new Error('visual motion timestamps must be non-decreasing');
    }

    const difference = sample.difference;
    if (difference && !difference.compatible) {
      this.liveTracks = [];
      this.coordinateSpace = undefined;
      this.lastSequence = sample.sequence;
      this.lastTimestampMs = timestampMs;
      return {
        sequence: sample.sequence,
        timestampMs,
        regions: [],
        tracks: [],
        collapsedInput: false,
      };
    }

    const tiles = difference?.changedTiles ?? [];
    const space = coordinateSpaceForTiles(tiles, this.coordinateSpace);
    if (this.coordinateSpace !== undefined && space !== this.coordinateSpace) {
      this.liveTracks = [];
    }
    this.coordinateSpace = space;

    let collapsedInput = false;
    let regions: VisualMotionRegion[] = [];
    if (difference?.changed && tiles.length > this.maxChangedTiles) {
      const bound = space === 'viewport' ? difference.viewportMotionBounds : difference.motionBounds;
      if (bound) regions = [{ rect: cloneRect(bound), tileCount: tiles.length }];
      collapsedInput = true;
    } else if (difference?.changed && tiles.length > 0) {
      regions = clusterTiles(tiles, space, this.mergeGapPx)
        .sort((a, b) => area(b.rect) - area(a.rect) || a.rect.y - b.rect.y || a.rect.x - b.rect.x)
        .slice(0, this.maxRegions);
    }

    this.associate(regions, sample.sequence, timestampMs, space);
    this.lastSequence = sample.sequence;
    this.lastTimestampMs = timestampMs;

    return {
      sequence: sample.sequence,
      timestampMs,
      coordinateSpace: space,
      regions: regions.map((region) => ({ rect: cloneRect(region.rect), tileCount: region.tileCount })),
      tracks: this.tracks(),
      collapsedInput,
    };
  }

  private associate(
    regions: readonly VisualMotionRegion[],
    sequence: number,
    timestampMs: number,
    space: VisualMotionCoordinateSpace,
  ): void {
    const pairs: Array<{ trackIndex: number; regionIndex: number; cost: number }> = [];

    for (let trackIndex = 0; trackIndex < this.liveTracks.length; trackIndex += 1) {
      const track = this.liveTracks[trackIndex];
      const elapsedMs = Math.max(0, timestampMs - track.lastSeenAtMs);
      const predictedRect = projectVisualMotionTrack(track, elapsedMs, this.maxProjectionMs);
      const predictedCenter = center(predictedRect);
      for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
        const region = regions[regionIndex];
        const regionCenter = center(region.rect);
        const distance = Math.hypot(
          regionCenter.x - predictedCenter.x,
          regionCenter.y - predictedCenter.y,
        );
        const overlap = intersectionOverUnion(predictedRect, region.rect);
        if (overlap <= 0 && distance > this.maxAssociationDistancePx) continue;
        const distanceCost = this.maxAssociationDistancePx > 0
          ? Math.min(1, distance / this.maxAssociationDistancePx)
          : (distance === 0 ? 0 : 1);
        const cost = distanceCost + (1 - overlap) * 0.25;
        pairs.push({ trackIndex, regionIndex, cost });
      }
    }

    pairs.sort((a, b) =>
      a.cost - b.cost ||
      this.liveTracks[a.trackIndex].id - this.liveTracks[b.trackIndex].id ||
      a.regionIndex - b.regionIndex,
    );
    const matchedTracks = new Set<number>();
    const matchedRegions = new Set<number>();

    for (const pair of pairs) {
      if (matchedTracks.has(pair.trackIndex) || matchedRegions.has(pair.regionIndex)) continue;
      matchedTracks.add(pair.trackIndex);
      matchedRegions.add(pair.regionIndex);
      const track = this.liveTracks[pair.trackIndex];
      const region = regions[pair.regionIndex];
      const nextCenter = center(region.rect);
      const elapsedMs = Math.max(0, timestampMs - track.lastSeenAtMs);
      let velocity = track.velocityPxPerSecond;
      if (elapsedMs > 0) {
        const measured = {
          x: (nextCenter.x - track.center.x) * 1000 / elapsedMs,
          y: (nextCenter.y - track.center.y) * 1000 / elapsedMs,
        };
        velocity = {
          x: track.velocityPxPerSecond.x * (1 - this.velocityAlpha) + measured.x * this.velocityAlpha,
          y: track.velocityPxPerSecond.y * (1 - this.velocityAlpha) + measured.y * this.velocityAlpha,
        };
      }
      this.liveTracks[pair.trackIndex] = {
        ...track,
        coordinateSpace: space,
        rect: cloneRect(region.rect),
        center: nextCenter,
        velocityPxPerSecond: velocity,
        confidence: Math.min(1, track.confidence + this.confidenceGain),
        ageSamples: track.ageSamples + 1,
        missedSamples: 0,
        lastSeenSequence: sequence,
        lastSeenAtMs: timestampMs,
      };
    }

    this.liveTracks = this.liveTracks
      .map((track, index) => {
        if (matchedTracks.has(index)) return track;
        return {
          ...track,
          confidence: Math.max(0, track.confidence - this.confidenceDecay),
          missedSamples: track.missedSamples + 1,
        };
      })
      .filter((track) => track.missedSamples <= this.maxMissedSamples && track.confidence > 0);

    for (let regionIndex = 0; regionIndex < regions.length; regionIndex += 1) {
      if (matchedRegions.has(regionIndex)) continue;
      const region = regions[regionIndex];
      this.liveTracks.push({
        id: this.nextTrackId++,
        coordinateSpace: space,
        rect: cloneRect(region.rect),
        center: center(region.rect),
        velocityPxPerSecond: { x: 0, y: 0 },
        confidence: this.initialConfidence,
        ageSamples: 1,
        missedSamples: 0,
        lastSeenSequence: sequence,
        lastSeenAtMs: timestampMs,
      });
    }

    this.liveTracks.sort((a, b) =>
      b.confidence - a.confidence ||
      b.ageSamples - a.ageSamples ||
      a.missedSamples - b.missedSamples ||
      a.id - b.id,
    );
    this.liveTracks = this.liveTracks.slice(0, this.maxTracks);
  }
}
