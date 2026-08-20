import type { InteractionEdge, InteractionEdgeKind, InteractionNode } from '../types.js';

export type FocusDirection = 'forward' | 'backward';

export interface FocusObservation {
  fromId: string;
  toId: string;
  direction: FocusDirection;
  observedAtMs?: number;
}

interface ObservationStats {
  count: number;
  lastObservedAtMs: number;
}

function focusKind(
  from: InteractionNode,
  to: InteractionNode,
  direction: FocusDirection,
): InteractionEdgeKind {
  if (from.frameId !== to.frameId && to.parentFrameId === from.frameId) return 'enter-frame';
  if (from.frameId !== to.frameId && from.parentFrameId === to.frameId) return 'exit-frame';
  return direction === 'forward' ? 'focus-next' : 'focus-previous';
}

function focusKey(direction: FocusDirection): string {
  return direction === 'forward' ? 'Tab' : 'Shift+Tab';
}

/**
 * Learns sequential focus movement from observations instead of assuming DOM
 * order exactly matches the browser's focus-navigation algorithm. When stable
 * frame ownership is available, direct parent/child crossings remain explicit
 * in the graph while retaining the actual Tab command that produced them.
 */
export class FocusTopology {
  private readonly observations = new Map<string, ObservationStats>();

  observe(observation: FocusObservation): void {
    if (!observation.fromId || !observation.toId || observation.fromId === observation.toId) return;
    const key = this.key(observation.fromId, observation.toId, observation.direction);
    const current = this.observations.get(key);
    this.observations.set(key, {
      count: (current?.count ?? 0) + 1,
      lastObservedAtMs: observation.observedAtMs ?? Date.now(),
    });
  }

  confidence(fromId: string, toId: string, direction: FocusDirection): number {
    const count = this.observations.get(this.key(fromId, toId, direction))?.count ?? 0;
    return count / (count + 1);
  }

  mostLikelyNext(fromId: string, direction: FocusDirection): string | null {
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
    const byId = new Map(nodes.map((node) => [node.id, node]));
    const edges: InteractionEdge[] = [];
    for (const [key, stats] of this.observations) {
      const { fromId, toId, direction } = this.parseKey(key);
      const from = byId.get(fromId);
      const to = byId.get(toId);
      if (!from || !to) continue;
      const confidence = stats.count / (stats.count + 1);
      edges.push({
        from: fromId,
        to: toId,
        kind: focusKind(from, to, direction),
        modality: 'keyboard',
        keyboardKey: focusKey(direction),
        estimatedTimeMs,
        failureProbability: 1 - confidence,
        uncertaintyCost: 1 - confidence,
      });
    }
    return edges;
  }

  private key(fromId: string, toId: string, direction: FocusDirection): string {
    return JSON.stringify([fromId, toId, direction]);
  }

  private parseKey(key: string): { fromId: string; toId: string; direction: FocusDirection } {
    const [fromId, toId, direction] = JSON.parse(key) as [string, string, FocusDirection];
    return { fromId, toId, direction };
  }
}
