import { SemanticActionController } from '../controller/semanticActionController.js';
import { targetPointCandidates } from '../geometry.js';
import type { BrowserInput } from '../input/browserInput.js';
import { PointerController } from '../controller/pointerController.js';
import type { InteractionNode, Point, Rect } from '../types.js';
import type { BrowserInteractionObserver } from './cdpObserver.js';
import type { CdpSessionLike } from './cdpIdentity.js';
import { captureCdpViewportGeometry, quadToRect } from './cdpGeometry.js';
import type { SnapshotFrameLike, SnapshotPageLike } from './domSnapshot.js';
import {
  snapshotInteractiveDomBounded,
  type BoundedSemanticSnapshotLimits,
} from './boundedSemanticSnapshot.js';

interface BoundedFrameSource {
  boundedFrames(maxFrames: number): { frames: readonly SnapshotFrameLike[]; complete: boolean };
}

interface StructuralBackendResolver extends SnapshotFrameLike {
  backendNodeIdForStructuralPath(path: string): Promise<number | undefined>;
}

interface RemoteObjectResult {
  object?: { objectId?: string };
}

interface CallFunctionResult {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

function structuralPath(node: InteractionNode): string | undefined {
  const prefix = `${node.frameId}:`;
  const value = node.structuralId ?? node.id;
  return value.startsWith(prefix) ? value.slice(prefix.length) : undefined;
}

function frameIndex(frameId: string): number | undefined {
  if (frameId === 'main') return 0;
  const match = /^frame-(\d+)$/.exec(frameId);
  if (!match) return undefined;
  const index = Number(match[1]);
  return Number.isSafeInteger(index) && index > 0 ? index : undefined;
}

async function remoteObjectId(session: CdpSessionLike, backendNodeId: number): Promise<string | undefined> {
  const resolved = await session.send('DOM.resolveNode', { backendNodeId }) as RemoteObjectResult;
  return resolved.object?.objectId;
}

async function backendContains(
  session: CdpSessionLike,
  ancestorBackendNodeId: number,
  candidateBackendNodeId: number,
): Promise<boolean> {
  if (ancestorBackendNodeId === candidateBackendNodeId) return true;
  const ancestorObjectId = await remoteObjectId(session, ancestorBackendNodeId);
  const candidateObjectId = await remoteObjectId(session, candidateBackendNodeId);
  if (!ancestorObjectId || !candidateObjectId) {
    if (ancestorObjectId) try { await session.send('Runtime.releaseObject', { objectId: ancestorObjectId }); } catch {}
    if (candidateObjectId) try { await session.send('Runtime.releaseObject', { objectId: candidateObjectId }); } catch {}
    return false;
  }
  try {
    const called = await session.send('Runtime.callFunctionOn', {
      objectId: ancestorObjectId,
      functionDeclaration: 'function(candidate) { return this === candidate || this.contains(candidate); }',
      arguments: [{ objectId: candidateObjectId }],
      returnByValue: true,
      awaitPromise: false,
    }) as CallFunctionResult;
    return !called.exceptionDetails && called.result?.value === true;
  } finally {
    try { await session.send('Runtime.releaseObject', { objectId: ancestorObjectId }); } catch {}
    try { await session.send('Runtime.releaseObject', { objectId: candidateObjectId }); } catch {}
  }
}

async function pointHitsTarget(
  session: CdpSessionLike,
  backendNodeId: number,
  point: Point,
): Promise<boolean> {
  const hit = await session.send('DOM.getNodeForLocation', {
    x: Math.round(point.x),
    y: Math.round(point.y),
    includeUserAgentShadowDOM: true,
    ignorePointerEventsNone: false,
  }) as { backendNodeId?: number };
  return typeof hit.backendNodeId === 'number' &&
    backendContains(session, backendNodeId, hit.backendNodeId);
}

async function targetBox(session: CdpSessionLike, backendNodeId: number): Promise<Rect | undefined> {
  try {
    const result = await session.send('DOM.getBoxModel', { backendNodeId }) as {
      model?: { border?: number[] };
    };
    return result.model?.border ? quadToRect(result.model.border) ?? undefined : undefined;
  } catch {
    return undefined;
  }
}

export class BoundedCdpSemanticActionObserver implements BrowserInteractionObserver {
  constructor(
    private readonly page: SnapshotPageLike,
    private readonly session: CdpSessionLike,
    private readonly limits: BoundedSemanticSnapshotLimits,
    private readonly targetId: string,
  ) {}

  async snapshot(): Promise<InteractionNode[]> {
    const snapshot = await snapshotInteractiveDomBounded(this.page, this.limits);
    const index = snapshot.nodes.findIndex((node) => node.id === this.targetId || node.structuralId === this.targetId);
    if (index < 0) return snapshot.nodes;
    const enriched = await this.enrichTarget(snapshot.nodes[index]);
    if (!enriched) return snapshot.nodes.filter((_, candidateIndex) => candidateIndex !== index);
    const nodes = [...snapshot.nodes];
    nodes[index] = enriched;
    return nodes;
  }

  async resolveTarget(): Promise<InteractionNode | undefined> {
    return (await this.snapshot()).find((node) => node.id === this.targetId || node.structuralId === this.targetId);
  }

  async targetPoint(node: InteractionNode): Promise<Point | null> {
    if (node.disabled || node.backendNodeId === undefined) return null;
    const rect = node.mainViewportRect ?? await targetBox(this.session, node.backendNodeId);
    if (!rect) return null;
    const { viewportRect } = await captureCdpViewportGeometry(this.session);
    for (const point of targetPointCandidates(rect, viewportRect, 4)) {
      if (await pointHitsTarget(this.session, node.backendNodeId, point)) return point;
    }
    return null;
  }

  async pointStillTargets(node: InteractionNode, point: Point): Promise<boolean> {
    return node.backendNodeId !== undefined && pointHitsTarget(this.session, node.backendNodeId, point);
  }

  async viewportRect(): Promise<Rect> {
    return (await captureCdpViewportGeometry(this.session)).viewportRect;
  }

  private async enrichTarget(node: InteractionNode): Promise<InteractionNode | undefined> {
    const path = structuralPath(node);
    const index = frameIndex(node.frameId);
    if (!path || index === undefined) return undefined;
    const source = this.page as SnapshotPageLike & Partial<BoundedFrameSource>;
    if (typeof source.boundedFrames !== 'function') return undefined;
    const frameBudget = Math.max(1, Math.min(32, this.limits.maxDepth));
    if (index >= frameBudget) return undefined;
    const supplied = source.boundedFrames(frameBudget);
    if (supplied.frames.length > frameBudget) return undefined;
    const frame = supplied.frames[index] as StructuralBackendResolver | undefined;
    if (!frame || typeof frame.backendNodeIdForStructuralPath !== 'function') return undefined;
    const backendNodeId = await frame.backendNodeIdForStructuralPath(path);
    if (backendNodeId === undefined) return undefined;
    const rect = await targetBox(this.session, backendNodeId);
    if (!rect) return { ...node, backendNodeId };
    const { viewportRect } = await captureCdpViewportGeometry(this.session);
    const left = Math.max(rect.x, viewportRect.x);
    const top = Math.max(rect.y, viewportRect.y);
    const right = Math.min(rect.x + rect.width, viewportRect.x + viewportRect.width);
    const bottom = Math.min(rect.y + rect.height, viewportRect.y + viewportRect.height);
    const visible = right > left && bottom > top
      ? { x: left, y: top, width: right - left, height: bottom - top }
      : undefined;
    return {
      ...node,
      backendNodeId,
      mainViewportRect: rect,
      mainViewportVisibleRect: visible,
      mainViewportVisible: visible !== undefined,
    };
  }
}

export function createBoundedSemanticActionController(
  page: SnapshotPageLike,
  session: CdpSessionLike,
  input: BrowserInput,
  pointer: PointerController,
  limits: BoundedSemanticSnapshotLimits,
  targetId: string,
): { observer: BoundedCdpSemanticActionObserver; controller: SemanticActionController } {
  const observer = new BoundedCdpSemanticActionObserver(page, session, limits, targetId);
  return { observer, controller: new SemanticActionController(observer, input, pointer) };
}
