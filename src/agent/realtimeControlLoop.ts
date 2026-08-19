import type { BrowserInput, MouseButton } from '../input/browserInput.js';
import type { Point } from '../types.js';

export type RealtimeControlStatus =
  | 'stopped'
  | 'tick-budget-exhausted'
  | 'time-budget-exhausted';

export interface RealtimeControlSample<TObservation> {
  tick: number;
  elapsedMs: number;
  deltaMs: number;
  observation: TObservation;
}

export interface RealtimeControlIntent {
  /** Keys that should remain held after this tick. Omitted means release all held keys. */
  heldKeys?: readonly string[];
  /** Mouse buttons that should remain held after this tick. Omitted means release all held buttons. */
  heldButtons?: readonly MouseButton[];
  /** Optional viewport point to move to before newly requested button presses. */
  pointer?: Point;
  stop?: boolean;
  reason?: string;
}

export interface RealtimeControlLoopOptions<TObservation> {
  observe(): Promise<TObservation>;
  decide(
    sample: RealtimeControlSample<TObservation>,
  ): RealtimeControlIntent | Promise<RealtimeControlIntent>;
  /** Target delay between completed ticks. Defaults to 16 ms. */
  tickIntervalMs?: number;
  /** Hard upper bound on policy decisions. Defaults to 3,600 ticks. */
  maxTicks?: number;
  /** Hard wall-clock bound for dispatching new control intents. Defaults to 60 seconds. */
  maxDurationMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface RealtimeControlResult<TObservation> {
  status: RealtimeControlStatus;
  ticks: number;
  elapsedMs: number;
  reason?: string;
  lastObservation?: TObservation;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function finiteNonNegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a finite non-negative number`);
  return value;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function uniqueKeys(keys: readonly string[] | undefined): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const key of keys ?? []) {
    if (typeof key !== 'string' || key.length === 0) throw new Error('heldKeys must contain non-empty strings');
    if (!seen.has(key)) {
      seen.add(key);
      result.push(key);
    }
  }
  return result;
}

function uniqueButtons(buttons: readonly MouseButton[] | undefined): MouseButton[] {
  const result: MouseButton[] = [];
  const seen = new Set<MouseButton>();
  for (const button of buttons ?? []) {
    if (button !== 'left' && button !== 'middle' && button !== 'right') {
      throw new Error(`unsupported mouse button: ${String(button)}`);
    }
    if (!seen.has(button)) {
      seen.add(button);
      result.push(button);
    }
  }
  return result;
}

function validatePoint(point: Point | undefined): void {
  if (!point) return;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error('pointer coordinates must be finite');
  }
}

/**
 * Bounded control loop for interactive pages such as canvas games and simulations.
 *
 * The policy declares the complete set of inputs that should remain held after
 * every tick. The loop diffs that intent against browser input state, avoiding
 * repeated keyDown events while a control is continuously held. All held keys
 * and mouse buttons are released in a final cleanup pass on normal stop, budget
 * exhaustion, observation failure, policy failure, or dispatch failure.
 *
 * This is an input/runtime primitive only. It intentionally contains no stealth,
 * fingerprint spoofing, anti-bot evasion, or page-side synthetic event logic.
 */
export class RealtimeControlLoop<TObservation> {
  private readonly heldKeys = new Set<string>();
  private readonly heldButtons = new Set<MouseButton>();
  private readonly tickIntervalMs: number;
  private readonly maxTicks: number;
  private readonly maxDurationMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;

  constructor(
    private readonly input: BrowserInput,
    private readonly options: RealtimeControlLoopOptions<TObservation>,
  ) {
    this.tickIntervalMs = finiteNonNegative('tickIntervalMs', options.tickIntervalMs ?? 16);
    this.maxTicks = positiveInteger('maxTicks', options.maxTicks ?? 3_600);
    this.maxDurationMs = finiteNonNegative('maxDurationMs', options.maxDurationMs ?? 60_000);
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => performance.now());
  }

  async run(): Promise<RealtimeControlResult<TObservation>> {
    const startedAt = this.now();
    let previousSampleAt = startedAt;
    let ticks = 0;
    let lastObservation: TObservation | undefined;
    let primaryError: unknown;

    const elapsed = () => Math.max(0, this.now() - startedAt);
    const result = (
      status: RealtimeControlStatus,
      reason?: string,
    ): RealtimeControlResult<TObservation> => ({
      status,
      ticks,
      elapsedMs: elapsed(),
      ...(reason ? { reason } : {}),
      ...(lastObservation === undefined ? {} : { lastObservation }),
    });

    try {
      while (ticks < this.maxTicks) {
        if (elapsed() >= this.maxDurationMs) return result('time-budget-exhausted');

        lastObservation = await this.options.observe();
        const sampledAt = this.now();
        if (elapsed() >= this.maxDurationMs) return result('time-budget-exhausted');

        const sample: RealtimeControlSample<TObservation> = {
          tick: ticks,
          elapsedMs: Math.max(0, sampledAt - startedAt),
          deltaMs: ticks === 0 ? 0 : Math.max(0, sampledAt - previousSampleAt),
          observation: lastObservation,
        };
        const intent = await this.options.decide(sample);
        if (elapsed() >= this.maxDurationMs) return result('time-budget-exhausted');

        await this.applyIntent(intent);
        ticks += 1;
        previousSampleAt = sampledAt;

        if (intent.stop) return result('stopped', intent.reason);
        if (ticks >= this.maxTicks) return result('tick-budget-exhausted');

        const elapsedMs = elapsed();
        if (elapsedMs >= this.maxDurationMs) return result('time-budget-exhausted');
        const remainingMs = Math.max(0, this.maxDurationMs - elapsedMs);
        if (this.tickIntervalMs > 0 && remainingMs > 0) {
          await this.sleep(Math.min(this.tickIntervalMs, remainingMs));
        }
      }
      return result('tick-budget-exhausted');
    } catch (error) {
      primaryError = error;
      throw error;
    } finally {
      try {
        await this.releaseAll();
      } catch (cleanupError) {
        if (primaryError === undefined) throw cleanupError;
      }
    }
  }

  private async applyIntent(intent: RealtimeControlIntent): Promise<void> {
    const desiredKeys = uniqueKeys(intent.heldKeys);
    const desiredButtons = uniqueButtons(intent.heldButtons);
    validatePoint(intent.pointer);
    const desiredKeySet = new Set(desiredKeys);
    const desiredButtonSet = new Set(desiredButtons);

    for (const key of [...this.heldKeys].reverse()) {
      if (desiredKeySet.has(key)) continue;
      await this.input.keyUp(key);
      this.heldKeys.delete(key);
    }
    for (const button of [...this.heldButtons].reverse()) {
      if (desiredButtonSet.has(button)) continue;
      await this.input.pointerUp(button);
      this.heldButtons.delete(button);
    }

    if (intent.pointer) await this.input.movePointer(intent.pointer);

    for (const key of desiredKeys) {
      if (this.heldKeys.has(key)) continue;
      await this.input.keyDown(key);
      this.heldKeys.add(key);
    }
    for (const button of desiredButtons) {
      if (this.heldButtons.has(button)) continue;
      await this.input.pointerDown(button);
      this.heldButtons.add(button);
    }
  }

  private async releaseAll(): Promise<void> {
    let firstError: unknown;
    for (const button of [...this.heldButtons].reverse()) {
      try {
        await this.input.pointerUp(button);
        this.heldButtons.delete(button);
      } catch (error) {
        firstError ??= error;
      }
    }
    for (const key of [...this.heldKeys].reverse()) {
      try {
        await this.input.keyUp(key);
        this.heldKeys.delete(key);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError !== undefined) throw firstError;
  }
}
