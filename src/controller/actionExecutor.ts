import {
  diffSnapshots,
  snapshotDeltaHasObservableChange,
  type SnapshotDelta,
  valueChangeSucceeded,
} from '../verification/actionVerifier.js';
import type { BrowserInput, MouseButton } from '../input/browserInput.js';
import type { Point, InteractionNode } from '../types.js';
import type { SnapshotProvider } from './focusController.js';
import { PointerController } from './pointerController.js';

export interface ObservedActionResult {
  before: readonly InteractionNode[];
  after: readonly InteractionNode[];
  delta: SnapshotDelta;
}

export interface TypeActionResult extends ObservedActionResult {
  verified: boolean | null;
}

export const hasObservableChange = snapshotDeltaHasObservableChange;

/**
 * Executes browser input with before/after observations. A command is not
 * treated as success merely because the adapter resolved without throwing.
 */
export class ActionExecutor {
  constructor(
    private readonly input: BrowserInput,
    private readonly pointer: PointerController,
    private readonly snapshot: SnapshotProvider,
  ) {}

  private async observe(action: () => Promise<void>): Promise<ObservedActionResult> {
    const before = await this.snapshot();
    await action();
    const after = await this.snapshot();
    return { before, after, delta: diffSnapshots(before, after) };
  }

  async click(
    point: Point,
    effectiveTargetWidthPx = 20,
    button: MouseButton = 'left',
  ): Promise<ObservedActionResult> {
    return this.observe(() => this.pointer.click(point, effectiveTargetWidthPx, button));
  }

  async typeText(
    text: string,
    options: { delayMs?: number; targetId?: string; expectedValue?: string } = {},
  ): Promise<TypeActionResult> {
    const observed = await this.observe(() => this.input.typeText(text, options.delayMs));
    const verified = options.targetId
      ? valueChangeSucceeded(observed.delta, options.targetId, options.expectedValue)
      : null;
    return { ...observed, verified };
  }

  async scroll(delta: Point): Promise<ObservedActionResult> {
    return this.observe(() => this.input.scroll(delta));
  }
}
