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
  | 'upload'
  | 'select'
  | 'set-range'
  | 'scroll'
  | 'expand'
  | 'dismiss';

export interface InteractionNode {
  id: string;
  /** Original structural frame/path identity when id has been stabilized. */
  structuralId?: string;
  /** Stable owning frame id (CDP frame id after CDP enrichment). */
  frameId: string;
  /** Stable parent frame id when the owning frame is not the top-level frame. */
  parentFrameId?: string;
  backendNodeId?: number;
  axNodeId?: string;
  role?: string;
  name?: string;
  value?: string;
  /** Browser-computed tab index. Negative values remain useful for roving-tabindex members. */
  tabIndex?: number;
  /** Structural identity of the nearest owning ARIA composite for keyboard navigation. */
  compositeOwnerStructuralId?: string;
  expanded?: boolean;
  checked?: boolean | 'mixed';
  selected?: boolean;
  pressed?: boolean | 'mixed';
  activeDescendantId?: string;
  /** Structural identity resolved from aria-activedescendant in the same DOM/shadow scope. */
  activeDescendantStructuralId?: string;
  /** Structural identity of the nearest independently scrollable ancestor. */
  scrollAncestorStructuralId?: string;
  focused: boolean;
  disabled: boolean;
  rect?: Rect;
  visibleRect?: Rect;
  /** Explicit visibility after frame viewport and overflow-ancestor clipping. */
  viewportVisible?: boolean;
  /** Browser-authoritative border box normalized into the main viewport. */
  mainViewportRect?: Rect;
  /** Main-viewport-clipped portion of mainViewportRect. */
  mainViewportVisibleRect?: Rect;
  mainViewportVisible?: boolean;
  focusable: boolean;
  clickable: boolean;
  editable: boolean;
  scrollable: boolean;
  capabilities: InteractionCapability[];
  interactionConfidence: number;
}

export type InteractionEdgeKind =
  | 'state-anchor'
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
  /** Optional explicit modality override; planners can infer common kinds. */
  modality?: 'keyboard' | 'pointer' | 'scroll';
  /** Exact learned keyboard command when kind alone is insufficient (for example frame crossings). */
  keyboardKey?: string;
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

export interface EdgeCostBreakdown {
  time: number;
  failure: number;
  modalitySwitch: number;
  scroll: number;
  uncertainty: number;
  total: number;
}

export const DEFAULT_PATH_COST_WEIGHTS: PathCostWeights = {
  failure: 800,
  modalitySwitch: 120,
  scroll: 180,
  uncertainty: 300,
};

export function edgeCostBreakdown(
  edge: InteractionEdge,
  weights: PathCostWeights = DEFAULT_PATH_COST_WEIGHTS,
): EdgeCostBreakdown {
  const time = edge.estimatedTimeMs;
  const failure = weights.failure * (edge.failureProbability ?? 0);
  const modalitySwitch = weights.modalitySwitch * (edge.modalitySwitchCost ?? 0);
  const scroll = weights.scroll * (edge.scrollCost ?? 0);
  const uncertainty = weights.uncertainty * (edge.uncertaintyCost ?? 0);
  return {
    time,
    failure,
    modalitySwitch,
    scroll,
    uncertainty,
    total: time + failure + modalitySwitch + scroll + uncertainty,
  };
}

export function edgeCost(
  edge: InteractionEdge,
  weights: PathCostWeights = DEFAULT_PATH_COST_WEIGHTS,
): number {
  return edgeCostBreakdown(edge, weights).total;
}
