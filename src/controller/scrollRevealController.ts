import type { BrowserInteractionObserver } from '../browser/cdpObserver.js';
import { effectiveTargetWidth, viewportScrollDeltaToReveal } from '../geometry.js';
import type { BrowserInput } from '../input/browserInput.js';
import type { InteractionNode, Point, Rect } from '../types.js';
import {
  waitForObservation,
  type ObservationWaitOptions,
} from '../verification/observationSettler.js';
import type { PointerController } from './pointerController.js';

export type ScrollRevealStatus =
  | 'already-visible'
  | 'revealed'
  | 'unsupported'
  | 'target-missing'
  | 'geometry-unavailable'
  | 'scroll-scope-unavailable'
  | 'stalled'
  | 'attempt-limit';

export interface ScrollRevealOptions extends ObservationWaitOptions {
  maxAttempts?: number;
  marginPx?: number;
  minimumDeltaPx?: number;
}

export interface ScrollRevealResult {
  status: ScrollRevealStatus;
  target: InteractionNode | null;
  attempts: number;
  totalScrollDelta: Point;
  remainingDelta: Point | null;
  /** Stable id when available, otherwise structural id; omitted for top-level viewport scrolling. */
  scrollScopeId?: string;
}

interface RevealContext {
  targetRect: Rect;
  scopeRect: Rect;
  scopeNode?: InteractionNode;
  remaining: Point;
}

function mainViewportRect(node: InteractionNode): Rect | undefined {
  if (node.mainViewportRect) return node.mainViewportRect;
  return node.frameId === 'main' ? node.rect : undefined;
}

function visibleScopeRect(node: InteractionNode): Rect | undefined {
  return node.mainViewportVisibleRect ?? node.mainViewportRect ??
    (node.frameId === 'main' ? node.visibleRect ?? node.rect : undefined);
}

function magnitude(point: Point): number {
  return Math.hypot(point.x, point.y);
}

function nearZero(point: Point, threshold: number): boolean {
  return Math.abs(point.x) <= threshold && Math.abs(point.y) <= threshold;
}

function findScrollAncestor(
  nodes: readonly InteractionNode[],
  target: InteractionNode,
): InteractionNode | undefined {
  const structuralId = target.scrollAncestorStructuralId;
  if (!structuralId) return undefined;
  return nodes.find((node) => node.structuralId === structuralId || node.id === structuralId);
}

function isReachablyVisible(node: InteractionNode): boolean {
  return node.mainViewportVisible !== false && node.viewportVisible !== false;
}

function makeContext(
  nodes: readonly InteractionNode[],
  target: InteractionNode,
  viewport: Rect,
  marginPx: number,
): RevealContext | null {
  const targetRect = mainViewportRect(target);
  if (!targetRect) return null;

  const ancestor = findScrollAncestor(nodes, target);
  if (ancestor && isReachablyVisible(ancestor)) {
    const scopeRect = visibleScopeRect(ancestor);
    if (scopeRect) {
      const remaining = viewportScrollDeltaToReveal(targetRect, scopeRect, marginPx);
      if (!nearZero(remaining, 0) || target.viewportVisible === false) {
        return { targetRect, scopeRect, scopeNode: ancestor, remaining };
      }
    }
  }

  return {
    targetRect,
    scopeRect: viewport,
    remaining: viewportScrollDeltaToReveal(targetRect, viewport, marginPx),
  };
}

/**
 * Reveals targets using bounded wheel attempts and geometry feedback. When the
 * DOM snapshot identifies a reachable scrollable ancestor, the pointer is moved
 * over that container before wheel input so scrolling is routed through the
 * same browser input path as an ordinary pointer-wheel interaction.
 */
export class ScrollRevealController {
  constructor(
    private readonly observer: BrowserInteractionObserver,
    private readonly input: BrowserInput,
    private readonly pointer?: PointerController,
  ) {}

  async reveal(target: InteractionNode, options: ScrollRevealOptions = {}): Promise<ScrollRevealResult> {
    if (!this.observer.viewportRect) {
      return {
        status: 'unsupported', target, attempts: 0,
        totalScrollDelta: { x: 0, y: 0 }, remainingDelta: null,
      };
    }

    const maxAttempts = Math.max(1, options.maxAttempts ?? 4);
    const marginPx = Math.max(0, options.marginPx ?? 16);
    const minimumDeltaPx = Math.max(0, options.minimumDeltaPx ?? 1);
    let snapshot = [...await this.observer.snapshot()];
    let current = snapshot.find((node) => node.id === target.id) ?? null;
    if (!current) {
      return {
        status: 'target-missing', target: null, attempts: 0,
        totalScrollDelta: { x: 0, y: 0 }, remainingDelta: null,
      };
    }

    if (isReachablyVisible(current)) {
      return {
        status: 'already-visible', target: current, attempts: 0,
        totalScrollDelta: { x: 0, y: 0 }, remainingDelta: { x: 0, y: 0 },
      };
    }

    let viewport = await this.observer.viewportRect();
    let context = makeContext(snapshot, current, viewport, marginPx);
    if (!context) {
      return {
        status: 'geometry-unavailable', target: current, attempts: 0,
        totalScrollDelta: { x: 0, y: 0 }, remainingDelta: null,
      };
    }

    const total = { x: 0, y: 0 };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      if (context.scopeNode) {
        if (!this.pointer) {
          return {
            status: 'scroll-scope-unavailable', target: current, attempts: attempt - 1,
            totalScrollDelta: total, remainingDelta: context.remaining,
            scrollScopeId: context.scopeNode.id,
          };
        }
        const scopePoint = await this.observer.targetPoint(context.scopeNode);
        if (!scopePoint) {
          return {
            status: 'scroll-scope-unavailable', target: current, attempts: attempt - 1,
            totalScrollDelta: total, remainingDelta: context.remaining,
            scrollScopeId: context.scopeNode.id,
          };
        }
        const movement = {
          x: scopePoint.x - this.pointer.touchpad.cursor.x,
          y: scopePoint.y - this.pointer.touchpad.cursor.y,
        };
        await this.pointer.moveTo(
          scopePoint,
          effectiveTargetWidth(context.scopeRect, movement),
        );
        if (!(await this.observer.pointStillTargets(context.scopeNode, scopePoint))) {
          return {
            status: 'scroll-scope-unavailable', target: current, attempts: attempt - 1,
            totalScrollDelta: total, remainingDelta: context.remaining,
            scrollScopeId: context.scopeNode.id,
          };
        }

        // Hover/layout effects during pointer travel may change the geometry.
        snapshot = [...await this.observer.snapshot()];
        current = snapshot.find((node) => node.id === target.id) ?? null;
        if (!current) {
          return {
            status: 'target-missing', target: null, attempts: attempt - 1,
            totalScrollDelta: total, remainingDelta: null,
          };
        }
        viewport = await this.observer.viewportRect();
        context = makeContext(snapshot, current, viewport, marginPx);
        if (!context) {
          return {
            status: 'geometry-unavailable', target: current, attempts: attempt - 1,
            totalScrollDelta: total, remainingDelta: null,
          };
        }
        if (isReachablyVisible(current)) {
          return {
            status: 'revealed', target: current, attempts: attempt - 1,
            totalScrollDelta: total, remainingDelta: { x: 0, y: 0 },
          };
        }
      }

      const requested = { ...context.remaining };
      if (nearZero(requested, minimumDeltaPx)) {
        return {
          status: isReachablyVisible(current) ? 'revealed' : 'stalled',
          target: current,
          attempts: attempt - 1,
          totalScrollDelta: total,
          remainingDelta: requested,
          ...(context.scopeNode ? { scrollScopeId: context.scopeNode.id } : {}),
        };
      }
      const beforeMagnitude = magnitude(requested);
      const scopeId = context.scopeNode?.id;
      await this.input.scroll(requested);
      total.x += requested.x;
      total.y += requested.y;

      const observed = await waitForObservation(
        () => this.observer.snapshot(),
        snapshot,
        (_delta, after) => {
          const candidate = after.find((node) => node.id === target.id);
          if (!candidate) return true;
          if (isReachablyVisible(candidate)) return true;
          const candidateContext = makeContext(after, candidate, viewport, marginPx);
          if (!candidateContext) return true;
          return magnitude(candidateContext.remaining) + minimumDeltaPx < beforeMagnitude;
        },
        options,
      );

      snapshot = [...observed.after];
      current = snapshot.find((node) => node.id === target.id) ?? null;
      if (!current) {
        return {
          status: 'target-missing', target: null, attempts: attempt,
          totalScrollDelta: total, remainingDelta: null,
          ...(scopeId ? { scrollScopeId: scopeId } : {}),
        };
      }
      if (isReachablyVisible(current)) {
        return {
          status: 'revealed', target: current, attempts: attempt,
          totalScrollDelta: total, remainingDelta: { x: 0, y: 0 },
          ...(scopeId ? { scrollScopeId: scopeId } : {}),
        };
      }

      viewport = await this.observer.viewportRect();
      const nextContext = makeContext(snapshot, current, viewport, marginPx);
      if (!nextContext) {
        return {
          status: 'geometry-unavailable', target: current, attempts: attempt,
          totalScrollDelta: total, remainingDelta: null,
          ...(scopeId ? { scrollScopeId: scopeId } : {}),
        };
      }
      context = nextContext;
      if (!observed.matched || magnitude(context.remaining) + minimumDeltaPx >= beforeMagnitude) {
        return {
          status: 'stalled', target: current, attempts: attempt,
          totalScrollDelta: total, remainingDelta: context.remaining,
          ...(scopeId ? { scrollScopeId: scopeId } : {}),
        };
      }
    }

    return {
      status: 'attempt-limit', target: current, attempts: maxAttempts,
      totalScrollDelta: total, remainingDelta: context.remaining,
      ...(context.scopeNode ? { scrollScopeId: context.scopeNode.id } : {}),
    };
  }
}
