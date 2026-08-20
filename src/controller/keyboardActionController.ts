import type { BrowserInteractionObserver } from '../browser/cdpObserver.js';
import type { BrowserInput } from '../input/browserInput.js';
import type { InteractionNode } from '../types.js';
import {
  snapshotDeltaHasObservableChange,
  type SnapshotDelta,
} from '../verification/actionVerifier.js';
import {
  waitForObservation,
  type ObservationWaitOptions,
} from '../verification/observationSettler.js';

export type KeyboardActionStatus = 'verified' | 'unverified';

export interface KeyboardActionResult {
  status: KeyboardActionStatus;
  verified: boolean;
  before: readonly InteractionNode[];
  after: readonly InteractionNode[];
  delta: SnapshotDelta;
  samples: number;
}

/**
 * Dispatches one static browser key/chord and verifies that browser semantics
 * changed. Focus transitions count as evidence here, unlike semantic activation
 * where focus-only movement is intentionally insufficient proof of activation.
 */
export class KeyboardActionController {
  constructor(
    private readonly observer: BrowserInteractionObserver,
    private readonly input: BrowserInput,
  ) {}

  async press(
    key: string,
    options: ObservationWaitOptions = {},
  ): Promise<KeyboardActionResult> {
    if (!key.trim()) throw new Error('keyboard key must be non-empty');
    const before = await this.observer.snapshot();
    await this.input.pressKey(key);
    const observed = await waitForObservation(
      () => this.observer.snapshot(),
      before,
      snapshotDeltaHasObservableChange,
      options,
    );
    return {
      status: observed.matched ? 'verified' : 'unverified',
      verified: observed.matched,
      before,
      after: observed.after,
      delta: observed.delta,
      samples: observed.samples,
    };
  }
}
