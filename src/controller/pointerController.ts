import type { BrowserInput, MouseButton } from '../input/browserInput.js';
import { fittsDurationMs, minimumJerkTrajectory } from '../motor/minimumJerk.js';
import { VirtualTouchpad } from '../motor/virtualTouchpad.js';
import type { Point } from '../types.js';

export interface PointerControllerOptions {
  pixelsPerMm?: number;
  sampleIntervalMs?: number;
  liftDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Closed-loop-friendly pointer executor. It produces a smooth browser cursor
 * trajectory while maintaining an independent bounded finger-space model.
 *
 * The virtual touchpad is a controller model only. The browser still receives
 * ordinary browser-automation pointer input through BrowserInput.
 */
export class PointerController {
  private readonly pixelsPerMm: number;
  private readonly sampleIntervalMs: number;
  private readonly liftDelayMs: number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    private readonly input: BrowserInput,
    readonly touchpad: VirtualTouchpad,
    options: PointerControllerOptions = {},
  ) {
    this.pixelsPerMm = Math.max(0.1, options.pixelsPerMm ?? 8);
    this.sampleIntervalMs = Math.max(1, options.sampleIntervalMs ?? 8);
    this.liftDelayMs = Math.max(0, options.liftDelayMs ?? 160);
    this.sleep = options.sleep ?? defaultSleep;
  }

  async moveTo(target: Point, effectiveTargetWidthPx = 20): Promise<void> {
    const start = { ...this.touchpad.cursor };
    const distance = Math.hypot(target.x - start.x, target.y - start.y);
    const durationMs = fittsDurationMs(distance, effectiveTargetWidthPx);
    const trajectory = minimumJerkTrajectory(start, target, {
      durationMs,
      sampleIntervalMs: this.sampleIntervalMs,
    });

    let previous = start;
    let previousTimeMs = 0;

    for (const sample of trajectory.slice(1)) {
      const cursorDelta = {
        x: sample.x - previous.x,
        y: sample.y - previous.y,
      };
      const fingerDelta = {
        x: cursorDelta.x / this.pixelsPerMm,
        y: cursorDelta.y / this.pixelsPerMm,
      };

      if (!this.touchpad.canApplyFingerDelta(fingerDelta)) {
        this.touchpad.lift();
        if (this.liftDelayMs > 0) await this.sleep(this.liftDelayMs);
        this.touchpad.recenter();
        this.touchpad.resume();
      }

      const dtSeconds = Math.max(0.001, (sample.tMs - previousTimeMs) / 1000);
      this.touchpad.applyFingerDelta(fingerDelta, {
        x: fingerDelta.x / dtSeconds,
        y: fingerDelta.y / dtSeconds,
      });

      // Browser coordinates are authoritative; the touchpad model is synced to
      // the actual commanded cursor after each stroke sample.
      this.touchpad.setCursor({ x: sample.x, y: sample.y });
      await this.input.movePointer({ x: sample.x, y: sample.y });

      const sleepMs = sample.tMs - previousTimeMs;
      if (sleepMs > 0) await this.sleep(sleepMs);
      previous = sample;
      previousTimeMs = sample.tMs;
    }
  }

  async click(
    target: Point,
    effectiveTargetWidthPx = 20,
    button: MouseButton = 'left',
  ): Promise<void> {
    await this.moveTo(target, effectiveTargetWidthPx);
    await this.input.pointerDown(button);
    await this.input.pointerUp(button);
  }
}
