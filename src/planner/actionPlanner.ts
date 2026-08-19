import {
  DEFAULT_PATH_COST_WEIGHTS,
  edgeCost,
  type InteractionEdge,
  type InteractionNode,
  type PathCostWeights,
} from '../types.js';

export interface PlanResult {
  edges: InteractionEdge[];
  totalCost: number;
  expandedNodes: number;
}

export type Heuristic = (node: InteractionNode, target: InteractionNode) => number;

/** A* over interaction edges. A zero heuristic reduces to Dijkstra. */
export function planInteractionPath(
  nodes: readonly InteractionNode[],
  edges: readonly InteractionEdge[],
  startId: string,
  targetId: string,
  options: { weights?: PathCostWeights; heuristic?: Heuristic } = {},
): PlanResult | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const start = byId.get(startId);
  const target = byId.get(targetId);
  if (!start || !target) return null;
  if (startId === targetId) return { edges: [], totalCost: 0, expandedNodes: 0 };

  const outgoing = new Map<string, InteractionEdge[]>();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const bucket = outgoing.get(edge.from) ?? [];
    bucket.push(edge);
    outgoing.set(edge.from, bucket);
  }

  const weights = options.weights ?? DEFAULT_PATH_COST_WEIGHTS;
  const heuristic = options.heuristic ?? (() => 0);
  const open = new Set<string>([startId]);
  const g = new Map<string, number>([[startId, 0]]);
  const f = new Map<string, number>([[startId, Math.max(0, heuristic(start, target))]]);
  const previous = new Map<string, InteractionEdge>();
  let expandedNodes = 0;

  while (open.size) {
    let current: string | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (const id of open) {
      const score = f.get(id) ?? Number.POSITIVE_INFINITY;
      if (score < best) {
        best = score;
        current = id;
      }
    }
    if (!current) break;

    if (current === targetId) {
      const path: InteractionEdge[] = [];
      let cursor = targetId;
      while (cursor !== startId) {
        const edge = previous.get(cursor);
        if (!edge) return null;
        path.push(edge);
        cursor = edge.from;
      }
      return {
        edges: path.reverse(),
        totalCost: g.get(targetId) ?? 0,
        expandedNodes,
      };
    }

    open.delete(current);
    expandedNodes += 1;
    for (const edge of outgoing.get(current) ?? []) {
      const tentative = (g.get(current) ?? Number.POSITIVE_INFINITY) + edgeCost(edge, weights);
      if (tentative >= (g.get(edge.to) ?? Number.POSITIVE_INFINITY)) continue;
      previous.set(edge.to, edge);
      g.set(edge.to, tentative);
      const next = byId.get(edge.to)!;
      f.set(edge.to, tentative + Math.max(0, heuristic(next, target)));
      open.add(edge.to);
    }
  }

  return null;
}

export const euclideanTimeHeuristic = (pixelsPerMs = 1): Heuristic => (node, target) => {
  const a = node.visibleRect ?? node.rect;
  const b = target.visibleRect ?? target.rect;
  if (!a || !b || pixelsPerMs <= 0) return 0;
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.hypot(bx - ax, by - ay) / pixelsPerMs;
};
