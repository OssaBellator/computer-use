import { rectContainsPoint, targetPointCandidates } from '../geometry.js';
import type { InteractionNode, Point, Rect } from '../types.js';

function visibleRect(node: InteractionNode): Rect | undefined {
  return node.mainViewportVisibleRect ?? node.visibleRect ??
    (node.mainViewportVisible !== false && node.viewportVisible !== false
      ? node.mainViewportRect ?? node.rect
      : undefined);
}

function usable(point: Point, viewport: Rect, blocked: readonly Rect[]): boolean {
  return rectContainsPoint(viewport, point) && !blocked.some((rect) => rectContainsPoint(rect, point));
}

/**
 * Choose a deterministic point where wheel input can bubble to the top-level
 * document instead of being captured by a visible independently scrollable
 * interaction scope. A safe preferred point is retained to avoid needless
 * pointer motion across repeated document-scroll attempts.
 */
export function chooseViewportWheelAnchor(
  viewport: Rect,
  nodes: readonly InteractionNode[],
  preferred?: Point,
  insetPx = 8,
): Point | null {
  const blocked = nodes
    .filter((node) => node.scrollable && node.mainViewportVisible !== false && node.viewportVisible !== false)
    .map(visibleRect)
    .filter((rect): rect is Rect => rect !== undefined);

  if (preferred && usable(preferred, viewport, blocked)) return { ...preferred };
  return targetPointCandidates(viewport, viewport, insetPx)
    .find((point) => usable(point, viewport, blocked)) ?? null;
}
