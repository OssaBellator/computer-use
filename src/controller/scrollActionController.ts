import type { BrowserInteractionObserver } from '../browser/cdpObserver.js';
import type { BrowserInput } from '../input/browserInput.js';
import type { InteractionNode, Point, Rect } from '../types.js';
import { diffSnapshots, type SnapshotDelta } from '../verification/actionVerifier.js';
import {
  waitForObservation,
  type ObservationWaitOptions,
} from '../verification/observationSettler.js';
import type { PointerController } from './pointerController.js';
import { chooseViewportWheelAnchor } from './scrollWheelRouting.js';

export const DEFAULT_MAX_VIEWPORT_SCROLL_DELTA_PX = 4000;

export type ScrollActionStatus =
  | 'verified'
  | 'unverified'
  | 'unsupported'
  | 'invalid-delta'
  | 'viewport-wheel-anchor-unavailable';

export interface ScrollActionOptions extends ObservationWaitOptions {
  /** Per-axis command ceiling. Defaults to 4000 CSS pixels. */
  maxDeltaPx?: number;
}

export interface ScrollActionResult {
  status: ScrollActionStatus;
  verified: boolean;
  commandedDelta: Point;
  anchor?: Point;
  before: readonly InteractionNode[];
  after: readonly InteractionNode[];
  delta: SnapshotDelta;
  samples: number;
}

function rectFor(node: InteractionNode): Rect | undefined {
  return node.mainViewportRect ?? node.rect;
}

function geometryOrVisibilityChanged(
  before: readonly InteractionNode[],
  after: readonly InteractionNode[],
): boolean {
  const afterById = new Map(after.map((node) => [node.id, node]));
  for (const beforeNode of before) {
    const afterNode = afterById.get(beforeNode.id);
    if (!afterNode) continue;
    const a = rectFor(beforeNode);
    const b = rectFor(afterNode);
    if (a && b && (Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5)) return true;
    if (beforeNode.viewportVisible !== afterNode.viewportVisible ||
        beforeNode.mainViewportVisible !== afterNode.mainViewportVisible) return true;
  }
  return false;
}

function scrollHasEvidence(
  before: readonly InteractionNode[],
  delta: SnapshotDelta,
  after: readonly InteractionNode[],
): boolean {
  return delta.added.length > 0 || delta.removed.length > 0 ||
    geometryOrVisibilityChanged(before, after);
}

function result(
  status: ScrollActionStatus,
  commandedDelta: Point,
  before: readonly InteractionNode[],
  after = before,
  anchor?: Point,
  samples = 0,
): ScrollActionResult {
  return {
    status,
    verified: status === 'verified',
    commandedDelta: { ...commandedDelta },
    ...(anchor ? { anchor: { ...anchor } } : {}),
    before,
    after,
    delta: diffSnapshots(before, after),
    samples,
  };
}

function samePoint(a: Point, b: Point): boolean {
  return Math.abs(a.x - b.x) <= 0.5 && Math.abs(a.y - b.y) <= 0.5;
}

/**
 * Verified top-level viewport scrolling. Wheel input is routed from a safe
 * viewport anchor outside visible nested scroll scopes. Pointer travel is
 * re-baselined so hover/layout changes cannot count as scroll evidence.
 */
export class ScrollActionController {
  constructor(
    private readonly observer: BrowserInteractionObserver,
    private readonly input: BrowserInput,
    private readonly pointer: PointerController,
  ) {}

  async scroll(
    commandedDelta: Point,
    options: ScrollActionOptions = {},
  ): Promise<ScrollActionResult> {
    if (!this.observer.viewportRect) {
      return result('unsupported', commandedDelta, await this.observer.snapshot());
    }
    const maxDeltaPx = options.maxDeltaPx ?? DEFAULT_MAX_VIEWPORT_SCROLL_DELTA_PX;
    if (!Number.isFinite(maxDeltaPx) || maxDeltaPx <= 0 ||
        !Number.isFinite(commandedDelta.x) || !Number.isFinite(commandedDelta.y) ||
        (commandedDelta.x === 0 && commandedDelta.y === 0) ||
        Math.abs(commandedDelta.x) > maxDeltaPx || Math.abs(commandedDelta.y) > maxDeltaPx) {
      return result('invalid-delta', commandedDelta, await this.observer.snapshot());
    }

    const viewport = await this.observer.viewportRect();
    let before = [...await this.observer.snapshot()];
    let anchor = chooseViewportWheelAnchor(
      viewport,
      before,
      { x: this.pointer.touchpad.cursor.x, y: this.pointer.touchpad.cursor.y },
    );
    if (!anchor) return result('viewport-wheel-anchor-unavailable', commandedDelta, before);

    await this.pointer.moveTo(anchor, Math.max(1, Math.min(viewport.width, viewport.height) / 4));
    before = [...await this.observer.snapshot()];

    // Hover side effects can introduce a new nested scroll scope. Revalidate the
    // anchor once against the post-travel semantic state before wheel dispatch.
    const revalidated = chooseViewportWheelAnchor(viewport, before, anchor);
    if (!revalidated) return result('viewport-wheel-anchor-unavailable', commandedDelta, before);
    if (!samePoint(revalidated, anchor)) {
      anchor = revalidated;
      await this.pointer.moveTo(anchor, Math.max(1, Math.min(viewport.width, viewport.height) / 4));
      before = [...await this.observer.snapshot()];
    }

    await this.input.scroll(commandedDelta);
    const observed = await waitForObservation(
      () => this.observer.snapshot(),
      before,
      (delta, after) => scrollHasEvidence(before, delta, after),
      options,
    );
    return {
      status: observed.matched ? 'verified' : 'unverified',
      verified: observed.matched,
      commandedDelta: { ...commandedDelta },
      anchor: { ...anchor },
      before,
      after: observed.after,
      delta: observed.delta,
      samples: observed.samples,
    };
  }
}
