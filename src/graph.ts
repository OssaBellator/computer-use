import {
  DEFAULT_PATH_COST_WEIGHTS,
  edgeCost,
  type InteractionEdge,
  type InteractionNode,
  type PathCostWeights,
  type Point,
} from './types.js';

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface DirectionalScoreWeights {
  distance: number;
  angle: number;
  axis: number;
  uncertainty: number;
}

const DEFAULT_DIRECTIONAL_WEIGHTS: DirectionalScoreWeights = {
  distance: 1,
  angle: 220,
  axis: 0.75,
  uncertainty: 180,
};

export class InteractionGraph {
  private readonly nodes = new Map<string, InteractionNode>();
  private readonly outgoing = new Map<string, InteractionEdge[]>();

  upsertNode(node: InteractionNode): void {
    this.nodes.set(node.id, node);
  }

  getNode(id: string): InteractionNode | undefined {
    return this.nodes.get(id);
  }

  addEdge(edge: InteractionEdge): void {
    if (!this.nodes.has(edge.from) || !this.nodes.has(edge.to)) {
      throw new Error(`Cannot add edge ${edge.from} -> ${edge.to}: both nodes must exist`);
    }
    const edges = this.outgoing.get(edge.from) ?? [];
    edges.push(edge);
    this.outgoing.set(edge.from, edges);
  }

  edgesFrom(id: string): readonly InteractionEdge[] {
    return this.outgoing.get(id) ?? [];
  }

  shortestPath(
    startId: string,
    targetId: string,
    weights: PathCostWeights = DEFAULT_PATH_COST_WEIGHTS,
  ): InteractionEdge[] | null {
    if (startId === targetId) return [];
    if (!this.nodes.has(startId) || !this.nodes.has(targetId)) return null;

    const distance = new Map<string, number>([[startId, 0]]);
    const previous = new Map<string, InteractionEdge>();
    const queue = new Set(this.nodes.keys());

    while (queue.size > 0) {
      let current: string | undefined;
      let best = Number.POSITIVE_INFINITY;
      for (const id of queue) {
        const d = distance.get(id) ?? Number.POSITIVE_INFINITY;
        if (d < best) {
          best = d;
          current = id;
        }
      }

      if (current === undefined || best === Number.POSITIVE_INFINITY) break;
      queue.delete(current);
      if (current === targetId) break;

      for (const edge of this.edgesFrom(current)) {
        if (!queue.has(edge.to)) continue;
        const candidate = best + edgeCost(edge, weights);
        if (candidate < (distance.get(edge.to) ?? Number.POSITIVE_INFINITY)) {
          distance.set(edge.to, candidate);
          previous.set(edge.to, edge);
        }
      }
    }

    if (!previous.has(targetId)) return null;
    const path: InteractionEdge[] = [];
    let cursor = targetId;
    while (cursor !== startId) {
      const edge = previous.get(cursor);
      if (!edge) return null;
      path.push(edge);
      cursor = edge.from;
    }
    return path.reverse();
  }
}

function center(node: InteractionNode): Point | null {
  const rect = node.visibleRect ?? node.rect;
  if (!rect) return null;
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function isInHalfPlane(origin: Point, candidate: Point, direction: Direction): boolean {
  if (direction === 'left') return candidate.x < origin.x;
  if (direction === 'right') return candidate.x > origin.x;
  if (direction === 'up') return candidate.y < origin.y;
  return candidate.y > origin.y;
}

export function directionalScore(
  originNode: InteractionNode,
  candidateNode: InteractionNode,
  direction: Direction,
  weights: DirectionalScoreWeights = DEFAULT_DIRECTIONAL_WEIGHTS,
): number {
  const origin = center(originNode);
  const candidate = center(candidateNode);
  if (!origin || !candidate || !isInHalfPlane(origin, candidate, direction)) {
    return Number.POSITIVE_INFINITY;
  }

  const dx = candidate.x - origin.x;
  const dy = candidate.y - origin.y;
  const distance = Math.hypot(dx, dy);
  const primary = direction === 'left' || direction === 'right' ? Math.abs(dx) : Math.abs(dy);
  const secondary = direction === 'left' || direction === 'right' ? Math.abs(dy) : Math.abs(dx);
  const angularDeviation = Math.atan2(secondary, Math.max(primary, Number.EPSILON));
  const axisPenalty = secondary;
  const uncertainty = 1 - Math.max(0, Math.min(1, candidateNode.interactionConfidence));

  return (
    weights.distance * distance +
    weights.angle * angularDeviation +
    weights.axis * axisPenalty +
    weights.uncertainty * uncertainty
  );
}

export function bestDirectionalCandidate(
  origin: InteractionNode,
  candidates: readonly InteractionNode[],
  direction: Direction,
): InteractionNode | null {
  let best: InteractionNode | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    if (candidate.id === origin.id || candidate.disabled) continue;
    const score = directionalScore(origin, candidate, direction);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return best;
}
