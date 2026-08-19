import { FocusTopology } from '../focus/focusTopology.js';
import { buildDirectionalEdges, createPointerMoveEdge } from '../graphBuilder.js';
import {
  planInteractionPath,
  type Heuristic,
  type InputModality,
  type PlanResult,
} from '../planner/actionPlanner.js';
import type { InteractionEdge, InteractionNode, PathCostWeights } from '../types.js';

export interface InteractionModelPlanOptions {
  includeDirectional?: boolean;
  includePointer?: boolean;
  weights?: PathCostWeights;
  heuristic?: Heuristic;
  initialModality?: InputModality;
}

/**
 * In-memory composition of the current page snapshot and learned interaction
 * topology. Refresh replaces volatile node geometry/state while preserving
 * learned focus observations across snapshots.
 */
export class InteractionModel {
  readonly focusTopology = new FocusTopology();
  private nodesById = new Map<string, InteractionNode>();

  refresh(nodes: readonly InteractionNode[]): void {
    this.nodesById = new Map(nodes.map((node) => [node.id, node]));
  }

  nodes(): InteractionNode[] {
    return [...this.nodesById.values()];
  }

  getNode(id: string): InteractionNode | undefined {
    return this.nodesById.get(id);
  }

  edgesForTarget(
    targetId: string,
    options: Pick<InteractionModelPlanOptions, 'includeDirectional' | 'includePointer'> = {},
  ): InteractionEdge[] {
    const nodes = this.nodes();
    const target = this.nodesById.get(targetId);
    if (!target) return [];
    const edges: InteractionEdge[] = [...this.focusTopology.toEdges(nodes)];
    if (options.includeDirectional ?? true) edges.push(...buildDirectionalEdges(nodes));
    if (options.includePointer ?? true) {
      for (const node of nodes) {
        if (node.id === targetId) continue;
        const edge = createPointerMoveEdge(node, target);
        if (edge) edges.push(edge);
      }
    }
    return edges;
  }

  plan(
    startId: string,
    targetId: string,
    options: InteractionModelPlanOptions = {},
  ): PlanResult | null {
    return planInteractionPath(
      this.nodes(),
      this.edgesForTarget(targetId, options),
      startId,
      targetId,
      {
        weights: options.weights,
        heuristic: options.heuristic,
        initialModality: options.initialModality,
      },
    );
  }
}
