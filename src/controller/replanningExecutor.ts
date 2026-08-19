import { InteractionModel, type InteractionModelPlanOptions } from '../model/interactionModel.js';
import { edgeModality, type InputModality } from '../planner/actionPlanner.js';
import type { InteractionEdge, InteractionNode } from '../types.js';
import type { SnapshotProvider } from './focusController.js';

export interface EdgeDispatchContext {
  model: InteractionModel;
  source: InteractionNode;
  target: InteractionNode;
}

export interface EdgeDispatchResult {
  succeeded: boolean;
  /** Override when execution establishes a different confirmed interaction anchor. */
  arrivedNodeId?: string;
  reason?: string;
}

export type EdgeDispatcher = (
  edge: InteractionEdge,
  context: EdgeDispatchContext,
) => Promise<EdgeDispatchResult>;

export type ReplanningStatus = 'reached' | 'no-plan' | 'replan-exhausted' | 'budget-exhausted';

export interface ExecutedPlanEdge {
  edge: InteractionEdge;
  result: EdgeDispatchResult;
}

export interface ReplanningResult {
  status: ReplanningStatus;
  finalNodeId: string;
  finalModality?: InputModality;
  replans: number;
  executed: ExecutedPlanEdge[];
  reason?: string;
}

export interface ReplanningOptions extends InteractionModelPlanOptions {
  maxReplans?: number;
  maxExecutedEdges?: number;
}

/**
 * Closed-loop plan runner. The dispatcher owns modality-specific mechanics and
 * success criteria; this runner owns snapshot refresh, confirmed-anchor tracking,
 * modality continuity, empirical edge feedback, and replanning after divergence.
 */
export class ReplanningExecutor {
  constructor(
    readonly model: InteractionModel,
    private readonly snapshot: SnapshotProvider,
    private readonly dispatch: EdgeDispatcher,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async execute(
    startId: string,
    targetId: string,
    options: ReplanningOptions = {},
  ): Promise<ReplanningResult> {
    const maxReplans = Math.max(0, options.maxReplans ?? 8);
    const maxExecutedEdges = Math.max(1, options.maxExecutedEdges ?? 100);
    const executed: ExecutedPlanEdge[] = [];
    let currentId = startId;
    let currentModality = options.initialModality;
    let replans = 0;

    const result = (status: ReplanningStatus, reason?: string): ReplanningResult => ({
      status,
      finalNodeId: currentId,
      finalModality: currentModality,
      replans,
      executed,
      reason,
    });

    while (replans <= maxReplans && executed.length < maxExecutedEdges) {
      this.model.refresh(await this.snapshot());
      if (currentId === targetId && this.model.getNode(targetId)) return result('reached');
      if (!this.model.getNode(currentId)) {
        const focused = this.model.nodes().find((node) => node.focused);
        if (focused) currentId = focused.id;
      }

      const plan = this.model.plan(currentId, targetId, {
        includeDirectional: options.includeDirectional,
        includePointer: options.includePointer,
        weights: options.weights,
        heuristic: options.heuristic,
        initialModality: currentModality,
      });
      if (!plan) {
        return result('no-plan', `No interaction path from ${currentId} to ${targetId}`);
      }

      let shouldReplan = false;
      for (const edge of plan.edges) {
        if (executed.length >= maxExecutedEdges) break;
        if (edge.from !== currentId) {
          shouldReplan = true;
          break;
        }
        const source = this.model.getNode(edge.from);
        const target = this.model.getNode(edge.to);
        if (!source || !target) {
          shouldReplan = true;
          break;
        }

        const startedAt = this.now();
        const dispatchResult = await this.dispatch(edge, { model: this.model, source, target });
        const durationMs = Math.max(0, this.now() - startedAt);
        this.model.edgePerformance.observe(edge, {
          durationMs,
          succeeded: dispatchResult.succeeded,
        });
        executed.push({ edge, result: dispatchResult });
        currentModality = edgeModality(edge) ?? currentModality;
        this.model.refresh(await this.snapshot());

        if (!dispatchResult.succeeded) {
          if (dispatchResult.arrivedNodeId && this.model.getNode(dispatchResult.arrivedNodeId)) {
            currentId = dispatchResult.arrivedNodeId;
          }
          shouldReplan = true;
          break;
        }

        currentId = dispatchResult.arrivedNodeId ?? edge.to;
        if (currentId === targetId && this.model.getNode(targetId)) return result('reached');

        if (currentId !== edge.to) {
          shouldReplan = true;
          break;
        }

        if (!this.model.getNode(currentId)) {
          const focused = this.model.nodes().find((node) => node.focused);
          if (focused) currentId = focused.id;
          shouldReplan = true;
          break;
        }
      }

      if (!shouldReplan && currentId !== targetId) shouldReplan = true;
      if (shouldReplan) replans += 1;
    }

    if (executed.length >= maxExecutedEdges) {
      return result('budget-exhausted', `Executed-edge budget of ${maxExecutedEdges} exhausted`);
    }
    return result('replan-exhausted', `Replan budget of ${maxReplans} exhausted`);
  }
}
