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
  | 'scope-cycle'
  | 'scope-depth-exceeded'
  | 'stalled'
  | 'attempt-limit';

export interface ScrollRevealOptions extends ObservationWaitOptions {
  /** Total wheel-dispatch budget across all nested scroll scopes. */
  maxAttempts?: number;
  marginPx?: number;
  minimumDeltaPx?: number;
  /** Maximum number of scroll-ancestor links followed before failing closed. */
  maxScopeDepth?: number;
}

export interface ScrollRevealResult {
  status: ScrollRevealStatus;
  target: InteractionNode | null;
  attempts: number;
  totalScrollDelta: Point;
  remainingDelta: Point | null;
  /** Last addressed nested scope; omitted for top-level viewport scrolling. */
  scrollScopeId?: string;
  /** Nested scopes addressed in actual wheel-dispatch order. */
  scrollScopeChain?: string[];
}

interface RevealContext {
  targetRect: Rect;
  scopeRect: Rect;
  scopeNode?: InteractionNode;
  remaining: Point;
}

interface RevealBudget {
  attempts: number;
  maxAttempts: number;
  totalScrollDelta: Point;
  scrollScopeChain: string[];
}

interface RevealSettings {
  marginPx: number;
  minimumDeltaPx: number;
  maxScopeDepth: number;
  observation: ScrollRevealOptions;
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

function structuralKey(node: InteractionNode): string {
  return node.structuralId ?? node.id;
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
      return {
        targetRect,
        scopeRect,
        scopeNode: ancestor,
        remaining: viewportScrollDeltaToReveal(targetRect, scopeRect, marginPx),
      };
    }
  }

  return {
    targetRect,
    scopeRect: viewport,
    remaining: viewportScrollDeltaToReveal(targetRect, viewport, marginPx),
  };
}

function resultFromBudget(
  status: ScrollRevealStatus,
  target: InteractionNode | null,
  budget: RevealBudget,
  remainingDelta: Point | null,
): ScrollRevealResult {
  const scrollScopeId = budget.scrollScopeChain.at(-1);
  return {
    status,
    target,
    attempts: budget.attempts,
    totalScrollDelta: { ...budget.totalScrollDelta },
    remainingDelta,
    ...(scrollScopeId ? { scrollScopeId } : {}),
    ...(budget.scrollScopeChain.length ? { scrollScopeChain: [...budget.scrollScopeChain] } : {}),
  };
}

/**
 * Reveals targets using browser wheel input and observation feedback. Nested
 * overflow scopes are handled outside-in: an off-screen scroll container is
 * first revealed through its own ancestor, then the pointer is moved over that
 * container before wheel input is issued for the original target.
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

    const budget: RevealBudget = {
      attempts: 0,
      maxAttempts: Math.max(1, options.maxAttempts ?? 4),
      totalScrollDelta: { x: 0, y: 0 },
      scrollScopeChain: [],
    };
    const settings: RevealSettings = {
      marginPx: Math.max(0, options.marginPx ?? 16),
      minimumDeltaPx: Math.max(0, options.minimumDeltaPx ?? 1),
      maxScopeDepth: Math.max(0, options.maxScopeDepth ?? 8),
      observation: options,
    };

    const initial = [...await this.observer.snapshot()];
    const current = initial.find((node) => node.id === target.id) ?? null;
    if (!current) return resultFromBudget('target-missing', null, budget, null);
    if (isReachablyVisible(current)) {
      return resultFromBudget('already-visible', current, budget, { x: 0, y: 0 });
    }

    return this.revealNode(target.id, settings, budget, 0, new Set<string>());
  }

  private async revealNode(
    targetId: string,
    settings: RevealSettings,
    budget: RevealBudget,
    depth: number,
    ancestry: Set<string>,
  ): Promise<ScrollRevealResult> {
    let snapshot = [...await this.observer.snapshot()];
    let current = snapshot.find((node) => node.id === targetId) ?? null;
    if (!current) return resultFromBudget('target-missing', null, budget, null);
    if (isReachablyVisible(current)) {
      return resultFromBudget('already-visible', current, budget, { x: 0, y: 0 });
    }
    if (depth > settings.maxScopeDepth) {
      return resultFromBudget('scope-depth-exceeded', current, budget, null);
    }

    const currentKey = structuralKey(current);
    if (ancestry.has(currentKey)) {
      return resultFromBudget('scope-cycle', current, budget, null);
    }
    const nextAncestry = new Set(ancestry);
    nextAncestry.add(currentKey);

    let ancestor = findScrollAncestor(snapshot, current);
    if (ancestor) {
      const ancestorKey = structuralKey(ancestor);
      if (nextAncestry.has(ancestorKey)) {
        return resultFromBudget('scope-cycle', current, budget, null);
      }
      if (depth >= settings.maxScopeDepth) {
        return resultFromBudget('scope-depth-exceeded', current, budget, null);
      }
      if (!isReachablyVisible(ancestor)) {
        const ancestorResult = await this.revealNode(
          ancestor.id,
          settings,
          budget,
          depth + 1,
          nextAncestry,
        );
        if (ancestorResult.status !== 'revealed' && ancestorResult.status !== 'already-visible') {
          return ancestorResult;
        }

        snapshot = [...await this.observer.snapshot()];
        current = snapshot.find((node) => node.id === targetId) ?? null;
        if (!current) return resultFromBudget('target-missing', null, budget, null);
        if (isReachablyVisible(current)) {
          return resultFromBudget('revealed', current, budget, { x: 0, y: 0 });
        }
        ancestor = findScrollAncestor(snapshot, current);
      }
    }

    return this.revealWithinCurrentScope(current, snapshot, settings, budget);
  }

  private async revealWithinCurrentScope(
    target: InteractionNode,
    initialSnapshot: InteractionNode[],
    settings: RevealSettings,
    budget: RevealBudget,
  ): Promise<ScrollRevealResult> {
    let snapshot = initialSnapshot;
    let current: InteractionNode | null = target;
    let viewport = await this.observer.viewportRect!();
    let context = makeContext(snapshot, current, viewport, settings.marginPx);
    if (!context) return resultFromBudget('geometry-unavailable', current, budget, null);

    while (budget.attempts < budget.maxAttempts) {
      if (context.scopeNode) {
        if (!this.pointer) {
          return resultFromBudget('scroll-scope-unavailable', current, budget, context.remaining);
        }
        const scopePoint = await this.observer.targetPoint(context.scopeNode);
        if (!scopePoint) {
          return resultFromBudget('scroll-scope-unavailable', current, budget, context.remaining);
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
          return resultFromBudget('scroll-scope-unavailable', current, budget, context.remaining);
        }

        snapshot = [...await this.observer.snapshot()];
        current = snapshot.find((node) => node.id === target.id) ?? null;
        if (!current) return resultFromBudget('target-missing', null, budget, null);
        if (isReachablyVisible(current)) {
          return resultFromBudget('revealed', current, budget, { x: 0, y: 0 });
        }
        viewport = await this.observer.viewportRect!();
        context = makeContext(snapshot, current, viewport, settings.marginPx);
        if (!context) return resultFromBudget('geometry-unavailable', current, budget, null);
      }

      const requested = { ...context.remaining };
      if (nearZero(requested, settings.minimumDeltaPx)) {
        return resultFromBudget(
          isReachablyVisible(current) ? 'revealed' : 'stalled',
          current,
          budget,
          requested,
        );
      }

      const beforeMagnitude = magnitude(requested);
      const addressedScopeId = context.scopeNode?.id;
      await this.input.scroll(requested);
      budget.attempts += 1;
      budget.totalScrollDelta.x += requested.x;
      budget.totalScrollDelta.y += requested.y;
      if (addressedScopeId && budget.scrollScopeChain.at(-1) !== addressedScopeId) {
        budget.scrollScopeChain.push(addressedScopeId);
      }

      const observed = await waitForObservation(
        () => this.observer.snapshot(),
        snapshot,
        (_delta, after) => {
          const candidate = after.find((node) => node.id === target.id);
          if (!candidate) return true;
          if (isReachablyVisible(candidate)) return true;
          const candidateContext = makeContext(after, candidate, viewport, settings.marginPx);
          if (!candidateContext) return true;
          return magnitude(candidateContext.remaining) + settings.minimumDeltaPx < beforeMagnitude;
        },
        settings.observation,
      );

      snapshot = [...observed.after];
      current = snapshot.find((node) => node.id === target.id) ?? null;
      if (!current) return resultFromBudget('target-missing', null, budget, null);
      if (isReachablyVisible(current)) {
        return resultFromBudget('revealed', current, budget, { x: 0, y: 0 });
      }

      viewport = await this.observer.viewportRect!();
      const nextContext = makeContext(snapshot, current, viewport, settings.marginPx);
      if (!nextContext) return resultFromBudget('geometry-unavailable', current, budget, null);
      context = nextContext;
      if (!observed.matched || magnitude(context.remaining) + settings.minimumDeltaPx >= beforeMagnitude) {
        return resultFromBudget('stalled', current, budget, context.remaining);
      }
    }

    return resultFromBudget('attempt-limit', current, budget, context.remaining);
  }
}
