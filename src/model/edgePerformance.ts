import type { InteractionEdge } from '../types.js';

export interface EdgePerformanceObservation {
  durationMs: number;
  succeeded: boolean;
}

export interface EdgePerformanceStats {
  attempts: number;
  failures: number;
  totalDurationMs: number;
}

export interface EdgePerformanceOptions {
  priorStrength?: number;
}

/**
 * Learns path-specific duration and failure rates while retaining each edge's
 * original estimates as priors. Early observations can influence planning
 * without allowing one noisy sample to dominate.
 */
export class EdgePerformanceModel {
  private readonly statsByKey = new Map<string, EdgePerformanceStats>();
  private readonly priorStrength: number;

  constructor(options: EdgePerformanceOptions = {}) {
    this.priorStrength = Math.max(0, options.priorStrength ?? 2);
  }

  observe(edge: InteractionEdge, observation: EdgePerformanceObservation): void {
    const key = this.key(edge);
    const stats = this.statsByKey.get(key) ?? { attempts: 0, failures: 0, totalDurationMs: 0 };
    stats.attempts += 1;
    if (!observation.succeeded) stats.failures += 1;
    stats.totalDurationMs += Math.max(0, observation.durationMs);
    this.statsByKey.set(key, stats);
  }

  stats(edge: InteractionEdge): EdgePerformanceStats | undefined {
    const stats = this.statsByKey.get(this.key(edge));
    return stats ? { ...stats } : undefined;
  }

  adjust(edge: InteractionEdge): InteractionEdge {
    const stats = this.statsByKey.get(this.key(edge));
    if (!stats || stats.attempts === 0) return { ...edge };

    const prior = this.priorStrength;
    const durationDenominator = stats.attempts + prior;
    const estimatedTimeMs = durationDenominator > 0
      ? (stats.totalDurationMs + prior * edge.estimatedTimeMs) / durationDenominator
      : edge.estimatedTimeMs;

    const baseFailure = Math.max(0, Math.min(1, edge.failureProbability ?? 0));
    const failureDenominator = stats.attempts + prior;
    const failureProbability = failureDenominator > 0
      ? (stats.failures + prior * baseFailure) / failureDenominator
      : baseFailure;

    return {
      ...edge,
      estimatedTimeMs,
      failureProbability: Math.max(0, Math.min(1, failureProbability)),
    };
  }

  clear(): void {
    this.statsByKey.clear();
  }

  private key(edge: InteractionEdge): string {
    return JSON.stringify([edge.from, edge.to, edge.kind, edge.modality ?? null]);
  }
}
