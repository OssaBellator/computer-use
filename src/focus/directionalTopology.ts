import type { Direction } from '../graph.js';
import type { InteractionEdge, InteractionEdgeKind, InteractionNode } from '../types.js';

export interface DirectionalObservation {
  fromId: string;
  toId: string;
  direction: Direction;
  observedAtMs?: number;
}

interface ObservationStats {
  count: number;
  lastObservedAtMs: number;
}

function edgeKind(direction: Direction): InteractionEdgeKind {
  return `spatial-${direction}` as InteractionEdgeKind;
}

/**
 * Learns Arrow-key spatial navigation from browser-observed focus movement.
 * Geometric neighbors remain only a prior; observations represent transitions
 * the page/browser has actually demonstrated.
 */
export class DirectionalTopology {
  private readonly observations = new Map<string, ObservationStats>();

  observe(observation: DirectionalObservation): void {
    if (!observation.fromId || !observation.toId || observation.fromId === observation.toId) return;
    const key = this.key(observation.fromId, observation.toId, observation.direction);
    const current = this.observations.get(key);
    this.observations.set(key, {
      count: (current?.count ?? 0) + 1,
      lastObservedAtMs: observation.observedAtMs ?? Date.now(),
    });
  }

  confidence(fromId: string, toId: string, direction: Direction): number {
    const count = this.observations.get(this.key(fromId, toId, direction))?.count ?? 0;
    return count / (count + 1);
  }

  mostLikelyNext(fromId: string, direction: Direction): string | null {
    let best: { toId: string; count: number; lastObservedAtMs: number } | null = null;
    for (const [key, stats] of this.observations) {
      const parsed = this.parseKey(key);
      if (parsed.fromId !== fromId || parsed.direction !== direction) continue;
      if (!best || stats.count > best.count ||
          (stats.count === best.count && stats.lastObservedAtMs > best.lastObservedAtMs)) {
        best = { toId: parsed.toId, ...stats };
      }
    }
    return best?.toId ?? null;
  }

  toEdges(nodes: readonly InteractionNode[], estimatedTimeMs = 90): InteractionEdge[] {
    const nodeIds = new Set(nodes.map((node) => node.id));
    const edges: InteractionEdge[] = [];
    for (const [key, stats] of this.observations) {
      const { fromId, toId, direction } = this.parseKey(key);
      if (!nodeIds.has(fromId) || !nodeIds.has(toId)) continue;
      const confidence = stats.count / (stats.count + 1);
      edges.push({
        from: fromId,
        to: toId,
        kind: edgeKind(direction),
        modality: 'keyboard',
        estimatedTimeMs,
        failureProbability: 1 - confidence,
        uncertaintyCost: 1 - confidence,
      });
    }
    return edges;
  }

  private key(fromId: string, toId: string, direction: Direction): string {
    return JSON.stringify([fromId, toId, direction]);
  }

  private parseKey(key: string): { fromId: string; toId: string; direction: Direction } {
    const [fromId, toId, direction] = JSON.parse(key) as [string, string, Direction];
    return { fromId, toId, direction };
  }
}
