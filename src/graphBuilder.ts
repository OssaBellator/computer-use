import { effectiveTargetWidth } from './geometry.js';
import { bestDirectionalCandidate, type Direction } from './graph.js';
import { fittsDurationMs } from './motor/minimumJerk.js';
import type { InteractionEdge, InteractionEdgeKind, InteractionNode, Point, Rect } from './types.js';

export const DEFAULT_SPECULATIVE_DIRECTION_FAILURE = 0.7;
export const DEFAULT_SPECULATIVE_DIRECTION_UNCERTAINTY = 0.6;

function rectFor(node: InteractionNode): Rect | undefined {
  return node.mainViewportVisibleRect ?? node.visibleRect ?? node.mainViewportRect ?? node.rect;
}

function viewportEligible(node: InteractionNode): boolean {
  return node.viewportVisible !== false && node.mainViewportVisible !== false;
}

function center(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function directionKind(direction: Direction): InteractionEdgeKind {
  return `spatial-${direction}` as InteractionEdgeKind;
}

/**
 * Builds geometric Arrow-key hypotheses. Geometry alone does not establish that
 * a page implements spatial keyboard navigation, so these edges intentionally
 * carry a strong failure/uncertainty prior. Browser-observed transitions are
 * represented separately by DirectionalTopology and become cheaper with evidence.
 */
export function buildDirectionalEdges(
  nodes: readonly InteractionNode[],
  estimatedTimeMs = 90,
  speculativeFailureProbability = DEFAULT_SPECULATIVE_DIRECTION_FAILURE,
): InteractionEdge[] {
  const eligible = nodes.filter((node) => !node.disabled && viewportEligible(node) &&
    !!rectFor(node) && (node.focusable || node.clickable || node.editable));
  const edges: InteractionEdge[] = [];
  const directions: Direction[] = ['up', 'down', 'left', 'right'];
  const speculativeFailure = Math.max(0, Math.min(1, speculativeFailureProbability));

  for (const origin of eligible) {
    const local = eligible.filter((candidate) => candidate.frameId === origin.frameId);
    for (const direction of directions) {
      const target = bestDirectionalCandidate(origin, local, direction);
      if (!target) continue;
      const targetUncertainty = 1 - Math.max(0, Math.min(1, target.interactionConfidence));
      edges.push({
        from: origin.id,
        to: target.id,
        kind: directionKind(direction),
        modality: 'keyboard',
        estimatedTimeMs,
        failureProbability: Math.max(speculativeFailure, targetUncertainty),
        uncertaintyCost: Math.max(DEFAULT_SPECULATIVE_DIRECTION_UNCERTAINTY, targetUncertainty),
      });
    }
  }
  return edges;
}

/**
 * Create an on-demand pointer edge. When a physical cursor origin is supplied,
 * its actual position—not the source DOM element's center—drives Fitts cost.
 */
export function createPointerMoveEdge(
  from: InteractionNode,
  to: InteractionNode,
  minimumTargetWidthPx = 4,
  pointerOrigin?: Point,
): InteractionEdge | null {
  const a = rectFor(from);
  const b = rectFor(to);
  const targetHasNormalizedGeometry = !!(to.mainViewportRect || to.mainViewportVisibleRect);
  const hasNormalizedGeometry = !!(from.mainViewportRect || from.mainViewportVisibleRect) && targetHasNormalizedGeometry;
  if (!b || (!pointerOrigin && !a) ||
      (!pointerOrigin && !hasNormalizedGeometry && from.frameId !== to.frameId) ||
      (pointerOrigin && !targetHasNormalizedGeometry) ||
      to.disabled || !viewportEligible(to)) return null;
  const start = pointerOrigin ?? center(a!);
  const target = center(b);
  const movement = { x: target.x - start.x, y: target.y - start.y };
  const width = Math.max(minimumTargetWidthPx, effectiveTargetWidth(b, movement));
  const distance = Math.hypot(movement.x, movement.y);
  const uncertainty = 1 - Math.max(0, Math.min(1, to.interactionConfidence));
  return {
    from: from.id,
    to: to.id,
    kind: 'pointer-move',
    estimatedTimeMs: fittsDurationMs(distance, width),
    failureProbability: uncertainty * 0.35,
    uncertaintyCost: uncertainty,
  };
}
