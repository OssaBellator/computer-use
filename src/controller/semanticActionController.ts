import type { BrowserInteractionObserver } from '../browser/cdpObserver.js';
import { effectiveTargetWidth } from '../geometry.js';
import type { BrowserInput } from '../input/browserInput.js';
import type { InteractionNode, Point, Rect } from '../types.js';
import {
  diffSnapshots,
  type SnapshotDelta,
  valueChangeSucceeded,
} from '../verification/actionVerifier.js';
import {
  waitForObservation,
  type ObservationWaitOptions,
  type ObservationWaitResult,
} from '../verification/observationSettler.js';
import { PointerController } from './pointerController.js';

export type SemanticActionStatus =
  | 'verified'
  | 'unverified'
  | 'not-actionable'
  | 'not-editable'
  | 'focus-failed'
  | 'target-point-unavailable'
  | 'target-moved';

export type ActivationMethod = 'auto' | 'keyboard' | 'pointer';

export interface SemanticActionResult {
  status: SemanticActionStatus;
  verified: boolean;
  target: InteractionNode;
  before: readonly InteractionNode[];
  after: readonly InteractionNode[];
  delta: SnapshotDelta;
  method?: Exclude<ActivationMethod, 'auto'>;
  samples: number;
}

export interface ActivateTargetOptions extends ObservationWaitOptions {
  method?: ActivationMethod;
  key?: string;
}

export interface HoverTargetOptions extends ObservationWaitOptions {}

export interface TypeIntoTargetOptions extends ObservationWaitOptions {
  delayMs?: number;
  expectedValue?: string;
}

interface PositionedTarget {
  status: 'positioned';
  target: InteractionNode;
  point: Point;
}

interface PositionFailure {
  status: 'target-point-unavailable' | 'target-moved';
  target: InteractionNode;
}

type PositionResult = PositionedTarget | PositionFailure;

function targetRect(node: InteractionNode): Rect | undefined {
  return node.mainViewportVisibleRect ?? node.visibleRect ?? node.mainViewportRect ?? node.rect;
}

function emptyResult(
  status: SemanticActionStatus,
  target: InteractionNode,
  before: readonly InteractionNode[],
): SemanticActionResult {
  return {
    status,
    verified: false,
    target,
    before,
    after: before,
    delta: diffSnapshots(before, before),
    samples: 0,
  };
}

function activationHasEvidence(delta: SnapshotDelta): boolean {
  return delta.added.length > 0 || delta.removed.length > 0 ||
    delta.changedValues.length > 0 || delta.changedStates.length > 0;
}

function defaultActivationKey(target: InteractionNode): string {
  const role = target.role?.toLowerCase();
  if (target.checked !== undefined || role === 'checkbox' || role === 'radio' || role === 'switch') {
    return ' ';
  }
  return 'Enter';
}

/**
 * Performs semantic actions only after a target has been resolved/acquired.
 * Commands are reported as verified only when browser snapshots provide
 * action-specific evidence; adapter completion alone is never treated as proof.
 */
export class SemanticActionController {
  constructor(
    private readonly observer: BrowserInteractionObserver,
    private readonly input: BrowserInput,
    private readonly pointer: PointerController,
  ) {}

  private async positionOnLiveTarget(target: InteractionNode, maxAttempts = 2): Promise<PositionResult> {
    let current = target;
    for (let attempt = 0; attempt < Math.max(1, maxAttempts); attempt += 1) {
      const point = await this.observer.targetPoint(current);
      if (!point) {
        return {
          status: attempt === 0 ? 'target-point-unavailable' : 'target-moved',
          target: current,
        };
      }
      const rect = targetRect(current);
      const movement: Point = {
        x: point.x - this.pointer.touchpad.cursor.x,
        y: point.y - this.pointer.touchpad.cursor.y,
      };
      await this.pointer.moveTo(point, rect ? effectiveTargetWidth(rect, movement) : 20);
      if (await this.observer.pointStillTargets(current, point)) {
        return { status: 'positioned', target: current, point };
      }

      const refreshed = await this.observer.snapshot();
      const next = refreshed.find((node) => node.id === current.id);
      if (!next) return { status: 'target-moved', target: current };
      current = next;
    }
    return { status: 'target-moved', target: current };
  }

  async activate(
    target: InteractionNode,
    options: ActivateTargetOptions = {},
  ): Promise<SemanticActionResult> {
    let before = await this.observer.snapshot();
    let current = before.find((node) => node.id === target.id) ?? target;
    if (current.disabled || (!current.clickable && !current.capabilities.includes('activate'))) {
      return emptyResult('not-actionable', current, before);
    }

    const requested = options.method ?? 'auto';
    const method: Exclude<ActivationMethod, 'auto'> = requested === 'auto'
      ? (current.focused ? 'keyboard' : 'pointer')
      : requested;

    if (method === 'keyboard') {
      await this.input.pressKey(options.key ?? defaultActivationKey(current));
    } else {
      const positioned = await this.positionOnLiveTarget(current);
      if (positioned.status !== 'positioned') {
        return emptyResult(positioned.status, positioned.target, before);
      }
      // Cursor travel can trigger hover/layout changes. Re-baseline immediately
      // before the click so those changes cannot count as activation evidence.
      before = await this.observer.snapshot();
      current = before.find((node) => node.id === positioned.target.id) ?? positioned.target;
      if (!(await this.observer.pointStillTargets(current, positioned.point))) {
        return emptyResult('target-moved', current, before);
      }
      await this.input.pointerDown('left');
      await this.input.pointerUp('left');
    }

    const observed = await waitForObservation(
      () => this.observer.snapshot(),
      before,
      activationHasEvidence,
      options,
    );
    return this.observationResult(current, before, observed, method);
  }

  /**
   * Moves the pointer onto a live semantic target and verifies hover-specific
   * browser evidence. The target is intentionally not re-hit-tested after
   * movement because a successful tooltip/menu may cover the original point.
   */
  async hover(
    target: InteractionNode,
    options: HoverTargetOptions = {},
  ): Promise<SemanticActionResult> {
    const before = await this.observer.snapshot();
    const current = before.find((node) => node.id === target.id) ?? target;
    const point = await this.observer.targetPoint(current);
    if (!point) return emptyResult('target-point-unavailable', current, before);

    const rect = targetRect(current);
    const movement: Point = {
      x: point.x - this.pointer.touchpad.cursor.x,
      y: point.y - this.pointer.touchpad.cursor.y,
    };
    await this.pointer.moveTo(point, rect ? effectiveTargetWidth(rect, movement) : 20);

    const observed = await waitForObservation(
      () => this.observer.snapshot(),
      before,
      activationHasEvidence,
      options,
    );
    return this.observationResult(current, before, observed, 'pointer');
  }

  async typeInto(
    target: InteractionNode,
    text: string,
    options: TypeIntoTargetOptions = {},
  ): Promise<SemanticActionResult> {
    let before = await this.observer.snapshot();
    let current = before.find((node) => node.id === target.id) ?? target;
    if (current.disabled || !current.editable || !current.capabilities.includes('type')) {
      return emptyResult('not-editable', current, before);
    }

    if (!current.focused) {
      const positioned = await this.positionOnLiveTarget(current);
      if (positioned.status !== 'positioned') {
        return emptyResult(positioned.status, positioned.target, before);
      }
      before = await this.observer.snapshot();
      current = before.find((node) => node.id === positioned.target.id) ?? positioned.target;
      if (!(await this.observer.pointStillTargets(current, positioned.point))) {
        return emptyResult('target-moved', current, before);
      }
      await this.input.pointerDown('left');
      await this.input.pointerUp('left');

      const focusObserved = await waitForObservation(
        () => this.observer.snapshot(),
        before,
        (delta) => delta.focusedAfter === current.id,
        options,
      );
      if (!focusObserved.matched) {
        return {
          status: 'focus-failed',
          verified: false,
          target: current,
          before,
          after: focusObserved.after,
          delta: focusObserved.delta,
          method: 'pointer',
          samples: focusObserved.samples,
        };
      }
      before = focusObserved.after;
      current = before.find((node) => node.id === current.id) ?? current;
    }

    await this.input.typeText(text, options.delayMs);
    const typed = await waitForObservation(
      () => this.observer.snapshot(),
      before,
      (delta) => valueChangeSucceeded(delta, current.id, options.expectedValue),
      options,
    );
    return this.observationResult(current, before, typed, undefined);
  }

  private observationResult(
    target: InteractionNode,
    before: readonly InteractionNode[],
    observed: ObservationWaitResult,
    method?: Exclude<ActivationMethod, 'auto'>,
  ): SemanticActionResult {
    return {
      status: observed.matched ? 'verified' : 'unverified',
      verified: observed.matched,
      target,
      before,
      after: observed.after,
      delta: observed.delta,
      method,
      samples: observed.samples,
    };
  }
}
