import { FocusTopology } from '../focus/focusTopology.js';
import { EdgePerformanceModel } from './edgePerformance.js';
import { buildDirectionalEdges, createPointerMoveEdge } from '../graphBuilder.js';
import {
  planInteractionPath,
  type Heuristic,
  type InputModality,
  type PlanResult,
} from '../planner/actionPlanner.js';
import type { InteractionEdge, InteractionNode, PathCostWeights, Point } from '../types.js';

export interface InteractionModelPlanOptions {
  includeDirectional?: boolean;
  includePointer?: boolean;
  weights?: PathCostWeights;
  heuristic?: Heuristic;
  initialModality?: InputModality;
}

export class InteractionModel {
  readonly focusTopology = new FocusTopology();
  readonly edgePerformance = new EdgePerformanceModel();
  private nodesById = new Map<string, InteractionNode>();
  private pointerPosition?: Point;

  refresh(nodes: readonly InteractionNode[]): void {
    this.nodesById = new Map(nodes.map((node) => [node.id, node]));
  }

  nodes(): InteractionNode[] {
    return [...this.nodesById.values()];
  }

  getNode(id: string): InteractionNode | undefined {
    return this.nodesById.get(id);
  }

  setPointerPosition(point: Point | undefined): void {
    this.pointerPosition = point ? { ...point } : undefined;
  }

  getPointerPosition(): Point | undefined {
    return this.pointerPosition ? { ...this.pointerPosition } : undefined;
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
        const edge = createPointerMoveEdge(node, target, 4, this.pointerPosition);
        if (edge) edges.push(edge);
      }
    }
    return edges.map((edge) => this.edgePerformance.adjust(edge));
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
