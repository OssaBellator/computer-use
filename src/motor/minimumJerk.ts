import type { Point } from '../types.js';

export interface TrajectorySample extends Point {
  tMs: number;
}

export interface MinimumJerkOptions {
  durationMs: number;
  sampleIntervalMs?: number;
}

export function minimumJerkProgress(u: number): number {
  const x = Math.max(0, Math.min(1, u));
  return 10 * x ** 3 - 15 * x ** 4 + 6 * x ** 5;
}

/**
 * Deterministic minimum-jerk path between two viewport points.
 *
 * Variation and correction should be introduced by a higher-level feedback
 * controller, not by injecting unbounded random coordinate noise here.
 */
export function minimumJerkTrajectory(
  start: Point,
  target: Point,
  options: MinimumJerkOptions,
): TrajectorySample[] {
  const durationMs = Math.max(1, options.durationMs);
  const intervalMs = Math.max(1, options.sampleIntervalMs ?? 8);
  const samples: TrajectorySample[] = [];

  for (let tMs = 0; tMs < durationMs; tMs += intervalMs) {
    const s = minimumJerkProgress(tMs / durationMs);
    samples.push({
      x: start.x + (target.x - start.x) * s,
      y: start.y + (target.y - start.y) * s,
      tMs,
    });
  }

  samples.push({ x: target.x, y: target.y, tMs: durationMs });
  return samples;
}

export function fittsDurationMs(
  distancePx: number,
  effectiveTargetWidthPx: number,
  aMs = 70,
  bMs = 110,
): number {
  const d = Math.max(0, distancePx);
  const w = Math.max(1, effectiveTargetWidthPx);
  return aMs + bMs * Math.log2(1 + d / w);
}
