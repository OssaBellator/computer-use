import { targetPointCandidates } from '../geometry.js';
import type { InteractionNode, Point, Rect } from '../types.js';

export interface HitTestFrameLike {
  evaluate<R, A>(pageFunction: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}

export interface HitTestResult {
  hit: boolean;
  topPath?: string;
  topTag?: string;
  topRole?: string;
}

interface HitTestRequest {
  point: Point;
  targetPath: string;
}

function localNodePath(node: InteractionNode): string {
  const prefix = `${node.frameId}:`;
  return node.id.startsWith(prefix) ? node.id.slice(prefix.length) : node.id;
}

/**
 * Validates a frame-local viewport point against actual paint order. Descendant
 * content counts as a hit on its owning interaction node; unrelated overlays do not.
 */
export async function pointHitsInteractionNode(
  frame: HitTestFrameLike,
  node: InteractionNode,
  point: Point,
): Promise<HitTestResult> {
  return frame.evaluate(({ point, targetPath }: HitTestRequest): HitTestResult => {
    function segment(element: Element): string {
      let index = 1;
      let sibling = element.previousElementSibling;
      while (sibling) {
        if (sibling.tagName === element.tagName) index += 1;
        sibling = sibling.previousElementSibling;
      }
      return `${element.tagName.toLowerCase()}:nth-of-type(${index})`;
    }

    function path(element: Element): string {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.documentElement) {
        parts.push(segment(current));
        const root = current.getRootNode();
        if (root instanceof ShadowRoot) {
          parts.push('::shadow');
          current = root.host;
        } else {
          current = current.parentElement;
        }
      }
      return parts.reverse().join(' > ');
    }

    function deepestAtPoint(root: Document | ShadowRoot): Element | null {
      const top = root.elementsFromPoint(point.x, point.y)[0] ?? null;
      if (!top) return null;
      if (top.shadowRoot) return deepestAtPoint(top.shadowRoot) ?? top;
      return top;
    }

    const top = deepestAtPoint(document);
    if (!top) return { hit: false };

    let current: Element | null = top;
    while (current) {
      if (path(current) === targetPath) {
        return {
          hit: true,
          topPath: path(top),
          topTag: top.tagName.toLowerCase(),
          topRole: top.getAttribute('role') ?? undefined,
        };
      }
      const root = current.getRootNode();
      current = current.parentElement ?? (root instanceof ShadowRoot ? root.host : null);
    }

    return {
      hit: false,
      topPath: path(top),
      topTag: top.tagName.toLowerCase(),
      topRole: top.getAttribute('role') ?? undefined,
    };
  }, { point, targetPath: localNodePath(node) });
}

/** Finds the first deterministic interior candidate that really hits the node. */
export async function findHitTestedTargetPoint(
  frame: HitTestFrameLike,
  node: InteractionNode,
  viewportRect: Rect,
  insetPx = 4,
): Promise<Point | null> {
  const rect = node.visibleRect ?? node.rect;
  if (!rect || node.disabled) return null;
  for (const point of targetPointCandidates(rect, viewportRect, insetPx)) {
    if ((await pointHitsInteractionNode(frame, node, point)).hit) return point;
  }
  return null;
}
