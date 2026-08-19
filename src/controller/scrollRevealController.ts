import type { BrowserInteractionObserver } from '../browser/cdpObserver.js';
import { viewportScrollDeltaToReveal } from '../geometry.js';
import type { BrowserInput } from '../input/browserInput.js';
import type { InteractionNode, Point, Rect } from '../types.js';
import {
  waitForObservation,
  type ObservationWaitOptions,
} from '../verification/observationSettler.js';

export type ScrollRevealStatus =
  | 'already-visible'
  | 'revealed'
  | 'unsupported'
  | 'target-missing'
  | 'geometry-unavailable'
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
}

function mainViewportRect(node: InteractionNode): Rect | undefined {
  if (node.mainViewportRect) return node.mainViewportRect;
  return node.frameId === 'main' ? node.rect : undefined;
}

function magnitude(point: Point): number {
  return Math.hypot(point.x, point.y);
}

function nearZero(point: Point, threshold: number): boolean {
  return Math.abs(point.x) <= threshold && Math.abs(point.y) <= threshold;
}

/**
 * Reveals an off-screen target using bounded wheel attempts and geometry
 * feedback. Each command is verified through a fresh semantic/CDP snapshot;
 * lack of geometric progress is reported rather than assumed successful.
 */
export class ScrollRevealController {
  constructor(
    private readonly observer: BrowserInteractionObserver,
    private readonly input: BrowserInput,
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
    let snapshot = await this.observer.snapshot();
    let current = snapshot.find((node) => node.id === target.id) ?? null;
    if (!current) {
      return {
        status: 'target-missing', target: null, attempts: 0,
        totalScrollDelta: { x: 0, y: 0 }, remainingDelta: null,
      };
    }

    let viewport = await this.observer.viewportRect();
    let rect = mainViewportRect(current);
    if (!rect) {
      return {
        status: 'geometry-unavailable', target: current, attempts: 0,
        totalScrollDelta: { x: 0, y: 0 }, remainingDelta: null,
      };
    }

    let remaining = viewportScrollDeltaToReveal(rect, viewport, marginPx);
    if (nearZero(remaining, minimumDeltaPx)) {
      return {
        status: 'already-visible', target: current, attempts: 0,
        totalScrollDelta: { x: 0, y: 0 }, remainingDelta: remaining,
      };
    }

    const total = { x: 0, y: 0 };
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const requested = { ...remaining };
      const beforeMagnitude = magnitude(requested);
      await this.input.scroll(requested);
      total.x += requested.x;
      total.y += requested.y;

      const observed = await waitForObservation(
        () => this.observer.snapshot(),
        snapshot,
        (_delta, after) => {
          const candidate = after.find((node) => node.id === target.id);
          if (!candidate) return true;
          const candidateRect = mainViewportRect(candidate);
          if (!candidateRect) return true;
          const candidateRemaining = viewportScrollDeltaToReveal(candidateRect, viewport, marginPx);
          return nearZero(candidateRemaining, minimumDeltaPx) ||
            magnitude(candidateRemaining) + minimumDeltaPx < beforeMagnitude;
        },
        options,
      );

      snapshot = [...observed.after];
      current = snapshot.find((node) => node.id === target.id) ?? null;
      if (!current) {
        return {
          status: 'target-missing', target: null, attempts: attempt,
          totalScrollDelta: total, remainingDelta: null,
        };
      }

      viewport = await this.observer.viewportRect();
      rect = mainViewportRect(current);
      if (!rect) {
        return {
          status: 'geometry-unavailable', target: current, attempts: attempt,
          totalScrollDelta: total, remainingDelta: null,
        };
      }
      remaining = viewportScrollDeltaToReveal(rect, viewport, marginPx);
      if (nearZero(remaining, minimumDeltaPx)) {
        return {
          status: 'revealed', target: current, attempts: attempt,
          totalScrollDelta: total, remainingDelta: remaining,
        };
      }
      if (!observed.matched || magnitude(remaining) + minimumDeltaPx >= beforeMagnitude) {
        return {
          status: 'stalled', target: current, attempts: attempt,
          totalScrollDelta: total, remainingDelta: remaining,
        };
      }
    }

    return {
      status: 'attempt-limit', target: current, attempts: maxAttempts,
      totalScrollDelta: total, remainingDelta: remaining,
    };
  }
}
