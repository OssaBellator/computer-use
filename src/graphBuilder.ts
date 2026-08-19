import { effectiveTargetWidth } from './geometry.js';
import { bestDirectionalCandidate, type Direction } from './graph.js';
import { fittsDurationMs } from './motor/minimumJerk.js';
import type { InteractionEdge, InteractionEdgeKind, InteractionNode, Point, Rect } from './types.js';

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
 * Derives one best directional neighbor per direction for each eligible node.
 * Candidates stay within a frame because arrow/spatial intent normally acts
 * on the currently perceived local surface; frame-enter/exit edges are separate.
 */
export function buildDirectionalEdges(
  nodes: readonly InteractionNode[],
  estimatedTimeMs = 90,
): InteractionEdge[] {
  const eligible = nodes.filter((node) => !node.disabled && viewportEligible(node) &&
    !!rectFor(node) && (node.focusable || node.clickable || node.editable));
  const edges: InteractionEdge[] = [];
  const directions: Direction[] = ['up', 'down', 'left', 'right'];

  for (const origin of eligible) {
    const local = eligible.filter((candidate) => candidate.frameId === origin.frameId);
    for (const direction of directions) {
      const target = bestDirectionalCandidate(origin, local, direction);
      if (!target) continue;
      const uncertainty = 1 - Math.max(0, Math.min(1, target.interactionConfidence));
      edges.push({
        from: origin.id,
        to: target.id,
        kind: directionKind(direction),
        estimatedTimeMs,
        failureProbability: uncertainty * 0.25,
        uncertaintyCost: uncertainty,
      });
    }
  }
  return edges;
}

/** Creates an on-demand pointer-move edge using target geometry and confidence. */
export function createPointerMoveEdge(
  from: InteractionNode,
  to: InteractionNode,
  minimumTargetWidthPx = 4,
): InteractionEdge | null {
  const a = rectFor(from);
  const b = rectFor(to);
  if (!a || !b || from.frameId !== to.frameId || to.disabled || !viewportEligible(to)) return null;
  const start = center(a);
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
