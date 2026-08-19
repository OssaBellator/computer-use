export interface Point {
  x: number;
  y: number;
}

export interface Rect extends Point {
  width: number;
  height: number;
}

export type InteractionCapability =
  | 'focus'
  | 'activate'
  | 'type'
  | 'scroll'
  | 'expand'
  | 'dismiss';

export interface InteractionNode {
  id: string;
  frameId: string;
  backendNodeId?: number;
  axNodeId?: string;
  role?: string;
  name?: string;
  value?: string;
  expanded?: boolean;
  checked?: boolean | 'mixed';
  selected?: boolean;
  pressed?: boolean | 'mixed';
  activeDescendantId?: string;
  focused: boolean;
  disabled: boolean;
  rect?: Rect;
  visibleRect?: Rect;
  /** Explicit viewport intersection state when captured from a live page. */
  viewportVisible?: boolean;
  focusable: boolean;
  clickable: boolean;
  editable: boolean;
  scrollable: boolean;
  capabilities: InteractionCapability[];
  interactionConfidence: number;
}

export type InteractionEdgeKind =
  | 'focus-next'
  | 'focus-previous'
  | 'spatial-up'
  | 'spatial-down'
  | 'spatial-left'
  | 'spatial-right'
  | 'pointer-move'
  | 'scroll-reveal'
  | 'enter-frame'
  | 'exit-frame'
  | 'focus'
  | 'activate'
  | 'type'
  | 'expand'
  | 'dismiss';

export interface InteractionEdge {
  from: string;
  to: string;
  kind: InteractionEdgeKind;
  /** Optional explicit modality override; planners infer common edge kinds. */
  modality?: 'keyboard' | 'pointer' | 'scroll';
  estimatedTimeMs: number;
  failureProbability?: number;
  modalitySwitchCost?: number;
  scrollCost?: number;
  uncertaintyCost?: number;
}

export interface PathCostWeights {
  failure: number;
  modalitySwitch: number;
  scroll: number;
  uncertainty: number;
}

export const DEFAULT_PATH_COST_WEIGHTS: PathCostWeights = {
  failure: 800,
  modalitySwitch: 120,
  scroll: 180,
  uncertainty: 300,
};

export function edgeCost(
  edge: InteractionEdge,
  weights: PathCostWeights = DEFAULT_PATH_COST_WEIGHTS,
): number {
  return (
    edge.estimatedTimeMs +
    weights.failure * (edge.failureProbability ?? 0) +
    weights.modalitySwitch * (edge.modalitySwitchCost ?? 0) +
    weights.scroll * (edge.scrollCost ?? 0) +
    weights.uncertainty * (edge.uncertaintyCost ?? 0)
  );
}
