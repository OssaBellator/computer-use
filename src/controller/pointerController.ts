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
const EPSILON = 1e-9;

/**
 * Closed-loop-friendly pointer executor. Browser coordinates are the commanded
 * output while the bounded finger model constrains how each segment is broken
 * into touchpad strokes. Oversized deltas are split rather than teleporting the
 * virtual finger beyond the modeled surface.
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

  private maximumStepScale(deltaMm: Point): number {
    let scale = 1;
    const halfWidth = this.touchpad.widthMm / 2;
    const halfHeight = this.touchpad.heightMm / 2;

    if (Math.abs(deltaMm.x) > EPSILON) {
      const availableX = deltaMm.x > 0
        ? halfWidth - this.touchpad.finger.x
        : halfWidth + this.touchpad.finger.x;
      scale = Math.min(scale, Math.max(0, availableX / Math.abs(deltaMm.x)));
    }
    if (Math.abs(deltaMm.y) > EPSILON) {
      const availableY = deltaMm.y > 0
        ? halfHeight - this.touchpad.finger.y
        : halfHeight + this.touchpad.finger.y;
      scale = Math.min(scale, Math.max(0, availableY / Math.abs(deltaMm.y)));
    }
    return Math.max(0, Math.min(1, scale));
  }

  private async liftAndRecenter(): Promise<void> {
    this.touchpad.lift();
    if (this.liftDelayMs > 0) await this.sleep(this.liftDelayMs);
    this.touchpad.recenter();
    this.touchpad.resume();
  }

  private async executeSegment(from: Point, to: Point, durationMs: number): Promise<void> {
    const totalCursorDelta = { x: to.x - from.x, y: to.y - from.y };
    const totalFingerDelta = {
      x: totalCursorDelta.x / this.pixelsPerMm,
      y: totalCursorDelta.y / this.pixelsPerMm,
    };
    let remaining = { ...totalFingerDelta };
    let commanded = { x: from.x, y: from.y };

    while (Math.abs(remaining.x) > EPSILON || Math.abs(remaining.y) > EPSILON) {
      let scale = this.maximumStepScale(remaining);
      if (scale <= EPSILON) {
        await this.liftAndRecenter();
        scale = this.maximumStepScale(remaining);
        if (scale <= EPSILON) {
          throw new Error('Virtual touchpad cannot make progress with current bounds/calibration');
        }
      }

      const fingerStep = { x: remaining.x * scale, y: remaining.y * scale };
      const fractionOfOriginal = Math.hypot(fingerStep.x, fingerStep.y) /
        Math.max(EPSILON, Math.hypot(totalFingerDelta.x, totalFingerDelta.y));
      const stepDurationMs = durationMs * fractionOfOriginal;
      const dtSeconds = Math.max(0.001, stepDurationMs / 1000);
      const result = this.touchpad.applyFingerDelta(fingerStep, {
        x: fingerStep.x / dtSeconds,
        y: fingerStep.y / dtSeconds,
      });
      if (result.boundaryReached) {
        await this.liftAndRecenter();
        continue;
      }

      const cursorStep = {
        x: fingerStep.x * this.pixelsPerMm,
        y: fingerStep.y * this.pixelsPerMm,
      };
      commanded = { x: commanded.x + cursorStep.x, y: commanded.y + cursorStep.y };
      remaining = { x: remaining.x - fingerStep.x, y: remaining.y - fingerStep.y };

      const finalStep = Math.abs(remaining.x) <= EPSILON && Math.abs(remaining.y) <= EPSILON;
      if (finalStep) commanded = { x: to.x, y: to.y };
      this.touchpad.setCursor(commanded);
      await this.input.movePointer(commanded);
      if (stepDurationMs > 0) await this.sleep(stepDurationMs);

      if (!finalStep && this.maximumStepScale(remaining) <= EPSILON) {
        await this.liftAndRecenter();
      }
    }

    this.touchpad.setCursor({ x: to.x, y: to.y });
  }

  async moveTo(target: Point, effectiveTargetWidthPx = 20): Promise<void> {
    const start = { ...this.touchpad.cursor };
    const distance = Math.hypot(target.x - start.x, target.y - start.y);
    const durationMs = fittsDurationMs(distance, effectiveTargetWidthPx);
    const trajectory = minimumJerkTrajectory(start, target, {
      durationMs,
      sampleIntervalMs: this.sampleIntervalMs,
    });

    let previous: Point = start;
    let previousTimeMs = 0;
    for (const sample of trajectory.slice(1)) {
      const segmentDuration = Math.max(0, sample.tMs - previousTimeMs);
      await this.executeSegment(previous, sample, segmentDuration);
      previous = { x: sample.x, y: sample.y };
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
