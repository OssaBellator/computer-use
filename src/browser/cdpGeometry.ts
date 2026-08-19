import { intersectRect, targetPointCandidates } from '../geometry.js';
import type { InteractionNode, Point, Rect } from '../types.js';
import type { CdpIdentityIndex, CdpSessionLike } from './cdpIdentity.js';

interface CdpBoxModel {
  content: number[];
  padding: number[];
  border: number[];
  margin: number[];
  width: number;
  height: number;
}

export interface CdpViewportGeometry {
  viewportRect: Rect;
  pageX: number;
  pageY: number;
  scale: number;
}

export interface CdpPointHitResult {
  hit: boolean;
  backendNodeId?: number;
  frameId?: string;
  hitPath?: string;
}

export function quadToRect(quad: readonly number[]): Rect | null {
  if (quad.length < 8) return null;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  if (![...xs, ...ys].every(Number.isFinite)) return null;
  const left = Math.min(...xs);
  const right = Math.max(...xs);
  const top = Math.min(...ys);
  const bottom = Math.max(...ys);
  if (right <= left || bottom <= top) return null;
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export async function captureCdpViewportGeometry(session: CdpSessionLike): Promise<CdpViewportGeometry> {
  const metrics = await session.send('Page.getLayoutMetrics');
  const viewport = metrics.cssVisualViewport ?? metrics.visualViewport ?? metrics.cssLayoutViewport ?? metrics.layoutViewport;
  return {
    // DOM.getBoxModel coordinates are main-viewport coordinates in Chromium,
    // including for descendants of iframes. The viewport therefore starts at 0,0.
    viewportRect: { x: 0, y: 0, width: viewport.clientWidth, height: viewport.clientHeight },
    pageX: viewport.pageX ?? 0,
    pageY: viewport.pageY ?? 0,
    scale: viewport.scale ?? 1,
  };
}

/** Enrich stable backend nodes with browser-authoritative main-viewport geometry. */
export async function enrichInteractionNodesWithCdpGeometry(
  nodes: readonly InteractionNode[],
  session: CdpSessionLike,
): Promise<InteractionNode[]> {
  const { viewportRect } = await captureCdpViewportGeometry(session);
  return Promise.all(nodes.map(async (node) => {
    if (node.backendNodeId === undefined) return { ...node };
    try {
      const result = await session.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
      const rect = quadToRect((result.model as CdpBoxModel).border);
      if (!rect) return { ...node };
      const visibleRect = intersectRect(rect, viewportRect) ?? undefined;
      return {
        ...node,
        mainViewportRect: rect,
        mainViewportVisibleRect: visibleRect,
        mainViewportVisible: visibleRect !== undefined,
      };
    } catch {
      return { ...node };
    }
  }));
}

function localIdentityMatchesTarget(
  target: InteractionNode,
  hitBackendNodeId: number,
  identities: CdpIdentityIndex,
): { hit: boolean; hitPath?: string; frameId?: string } {
  if (target.backendNodeId === undefined) return { hit: false };
  const targetIdentity = identities.byBackendNodeId.get(target.backendNodeId);
  const hitIdentity = identities.byBackendNodeId.get(hitBackendNodeId);
  if (!targetIdentity || !hitIdentity || targetIdentity.frameId !== hitIdentity.frameId) return { hit: false };
  const hit = hitIdentity.path === targetIdentity.path ||
    hitIdentity.path.startsWith(`${targetIdentity.path} > `);
  return { hit, hitPath: hitIdentity.path, frameId: hitIdentity.frameId };
}

/** Hit test in the main viewport directly through frame boundaries using backend DOM identity. */
export async function pointHitsCdpInteractionNode(
  session: CdpSessionLike,
  identities: CdpIdentityIndex,
  node: InteractionNode,
  point: Point,
): Promise<CdpPointHitResult> {
  if (node.backendNodeId === undefined) return { hit: false };
  const result = await session.send('DOM.getNodeForLocation', {
    x: Math.round(point.x),
    y: Math.round(point.y),
    includeUserAgentShadowDOM: true,
    ignorePointerEventsNone: false,
  });
  const backendNodeId = result.backendNodeId as number | undefined;
  if (backendNodeId === undefined) return { hit: false };
  const matched = localIdentityMatchesTarget(node, backendNodeId, identities);
  return { ...matched, backendNodeId, frameId: result.frameId ?? matched.frameId };
}

/** Find a deterministic main-viewport point whose deepest backend node belongs to the target. */
export async function findCdpHitTestedTargetPoint(
  session: CdpSessionLike,
  identities: CdpIdentityIndex,
  node: InteractionNode,
  insetPx = 4,
): Promise<Point | null> {
  if (node.disabled || node.backendNodeId === undefined || node.mainViewportVisible === false) return null;
  const rect = node.mainViewportRect;
  if (!rect) return null;
  const { viewportRect } = await captureCdpViewportGeometry(session);
  for (const point of targetPointCandidates(rect, viewportRect, insetPx)) {
    if ((await pointHitsCdpInteractionNode(session, identities, node, point)).hit) return point;
  }
  return null;
}
