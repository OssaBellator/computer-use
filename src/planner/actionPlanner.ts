import {
  edgeCost,
  type InteractionEdge,
  type InteractionEdgeKind,
  type InteractionNode,
  type PathCostWeights,
  DEFAULT_PATH_COST_WEIGHTS,
} from '../types.js';

export type InputModality = 'keyboard' | 'pointer' | 'scroll';

export interface PlanResult {
  edges: InteractionEdge[];
  totalCost: number;
  expandedNodes: number;
  finalModality?: InputModality;
}

export type Heuristic = (node: InteractionNode, target: InteractionNode) => number;

export interface PlanOptions {
  weights?: PathCostWeights;
  heuristic?: Heuristic;
  initialModality?: InputModality;
}

const KEYBOARD_KINDS = new Set<InteractionEdgeKind>([
  'focus-next',
  'focus-previous',
  'spatial-up',
  'spatial-down',
  'spatial-left',
  'spatial-right',
  'focus',
  'activate',
  'type',
  'expand',
  'dismiss',
]);

export function edgeModality(edge: InteractionEdge): InputModality | undefined {
  if (edge.modality) return edge.modality;
  if (edge.kind === 'pointer-move') return 'pointer';
  if (edge.kind === 'scroll-reveal') return 'scroll';
  if (KEYBOARD_KINDS.has(edge.kind)) return 'keyboard';
  return undefined;
}

function stateKey(nodeId: string, modality: InputModality | undefined): string {
  return `${nodeId}\u0000${modality ?? ''}`;
}

interface SearchState {
  nodeId: string;
  modality?: InputModality;
}

/**
 * A* over interaction edges with path-state-aware modality switching.
 * The same graph node can remain in multiple search states when it was reached
 * through different modalities, preventing locally cheap arrivals from hiding
 * globally cheaper continuations.
 */
export function planInteractionPath(
  nodes: readonly InteractionNode[],
  edges: readonly InteractionEdge[],
  startId: string,
  targetId: string,
  options: PlanOptions = {},
): PlanResult | null {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const start = byId.get(startId);
  const target = byId.get(targetId);
  if (!start || !target) return null;
  if (startId === targetId) {
    return { edges: [], totalCost: 0, expandedNodes: 0, finalModality: options.initialModality };
  }

  const outgoing = new Map<string, InteractionEdge[]>();
  for (const edge of edges) {
    if (!byId.has(edge.from) || !byId.has(edge.to)) continue;
    const bucket = outgoing.get(edge.from) ?? [];
    bucket.push(edge);
    outgoing.set(edge.from, bucket);
  }

  const weights = options.weights ?? DEFAULT_PATH_COST_WEIGHTS;
  const heuristic = options.heuristic ?? (() => 0);
  const startState: SearchState = { nodeId: startId, modality: options.initialModality };
  const startKey = stateKey(startId, startState.modality);
  const states = new Map<string, SearchState>([[startKey, startState]]);
  const open = new Set<string>([startKey]);
  const g = new Map<string, number>([[startKey, 0]]);
  const f = new Map<string, number>([[startKey, Math.max(0, heuristic(start, target))]]);
  const previous = new Map<string, { previousKey: string; edge: InteractionEdge }>();
  let expandedNodes = 0;

  while (open.size) {
    let currentKey: string | undefined;
    let best = Number.POSITIVE_INFINITY;
    for (const key of open) {
      const score = f.get(key) ?? Number.POSITIVE_INFINITY;
      if (score < best) {
        best = score;
        currentKey = key;
      }
    }
    if (!currentKey) break;

    const current = states.get(currentKey)!;
    if (current.nodeId === targetId) {
      const path: InteractionEdge[] = [];
      let cursorKey = currentKey;
      while (cursorKey !== startKey) {
        const step = previous.get(cursorKey);
        if (!step) return null;
        path.push(step.edge);
        cursorKey = step.previousKey;
      }
      return {
        edges: path.reverse(),
        totalCost: g.get(currentKey) ?? 0,
        expandedNodes,
        finalModality: current.modality,
      };
    }

    open.delete(currentKey);
    expandedNodes += 1;

    for (const edge of outgoing.get(current.nodeId) ?? []) {
      const requestedModality = edgeModality(edge);
      const nextModality = requestedModality ?? current.modality;
      const switched =
        current.modality !== undefined &&
        requestedModality !== undefined &&
        current.modality !== requestedModality;
      const transitionCost = edgeCost(edge, weights) + (switched ? weights.modalitySwitch : 0);
      const tentative = (g.get(currentKey) ?? Number.POSITIVE_INFINITY) + transitionCost;
      const nextKey = stateKey(edge.to, nextModality);
      if (tentative >= (g.get(nextKey) ?? Number.POSITIVE_INFINITY)) continue;

      const nextState: SearchState = { nodeId: edge.to, modality: nextModality };
      states.set(nextKey, nextState);
      previous.set(nextKey, { previousKey: currentKey, edge });
      g.set(nextKey, tentative);
      const nextNode = byId.get(edge.to)!;
      f.set(nextKey, tentative + Math.max(0, heuristic(nextNode, target)));
      open.add(nextKey);
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
