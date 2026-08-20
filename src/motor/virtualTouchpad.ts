import type { Point } from '../types.js';

export type FingerState = 'idle' | 'contact' | 'moving' | 'lifted' | 'recentering';

export interface TouchpadTransferFunction {
  (deltaMm: Point, velocityMmPerSecond: Point): Point;
}

export interface FingerTrackingResult {
  boundaryReached: boolean;
  finger: Point;
}

export interface TouchpadStepResult extends FingerTrackingResult {
  cursor: Point;
  cursorDelta: Point;
}

export interface VirtualTouchpadOptions {
  widthMm?: number;
  heightMm?: number;
  initialCursor?: Point;
  transferFunction?: TouchpadTransferFunction;
}

const identityTransfer: TouchpadTransferFunction = (deltaMm) => ({ ...deltaMm });

/**
 * Stateful virtual touchpad model. Finger coordinates are physical-model
 * coordinates centered at (0, 0); cursor coordinates are viewport pixels.
 * A finger lift/recenter never changes the cursor position.
 */
export class VirtualTouchpad {
  readonly widthMm: number;
  readonly heightMm: number;
  finger: Point = { x: 0, y: 0 };
  cursor: Point;
  state: FingerState = 'idle';

  private readonly transferFunction: TouchpadTransferFunction;

  constructor(options: VirtualTouchpadOptions = {}) {
    this.widthMm = options.widthMm ?? 120;
    this.heightMm = options.heightMm ?? 80;
    this.cursor = { ...(options.initialCursor ?? { x: 0, y: 0 }) };
    this.transferFunction = options.transferFunction ?? identityTransfer;
  }

  touchDown(): void {
    this.state = 'contact';
  }

  canApplyFingerDelta(deltaMm: Point): boolean {
    return this.insidePad({
      x: this.finger.x + deltaMm.x,
      y: this.finger.y + deltaMm.y,
    });
  }

  /**
   * Advances only the modeled finger position. This is used by controllers
   * whose cursor transfer/calibration is owned externally (for example,
   * PointerController's pixelsPerMm calibration).
   */
  trackFingerDelta(deltaMm: Point): FingerTrackingResult {
    if (!this.canApplyFingerDelta(deltaMm)) {
      return {
        boundaryReached: true,
        finger: { ...this.finger },
      };
    }

    this.state = 'moving';
    this.finger = {
      x: this.finger.x + deltaMm.x,
      y: this.finger.y + deltaMm.y,
    };
    return {
      boundaryReached: false,
      finger: { ...this.finger },
    };
  }

  /**
   * Standalone touchpad simulation step. Unlike trackFingerDelta(), this also
   * applies the configured transfer curve to viewport cursor state.
   */
  applyFingerDelta(
    deltaMm: Point,
    velocityMmPerSecond: Point = { x: 0, y: 0 },
  ): TouchpadStepResult {
    const tracked = this.trackFingerDelta(deltaMm);
    if (tracked.boundaryReached) {
      return {
        ...tracked,
        cursor: { ...this.cursor },
        cursorDelta: { x: 0, y: 0 },
      };
    }

    const cursorDelta = this.transferFunction(deltaMm, velocityMmPerSecond);
    this.cursor = {
      x: this.cursor.x + cursorDelta.x,
      y: this.cursor.y + cursorDelta.y,
    };

    return {
      ...tracked,
      cursor: { ...this.cursor },
      cursorDelta,
    };
  }

  lift(): void {
    this.state = 'lifted';
  }

  recenter(): void {
    this.state = 'recentering';
    this.finger = { x: 0, y: 0 };
  }

  resume(): void {
    this.state = 'contact';
  }

  liftAndRecenter(): void {
    this.lift();
    this.recenter();
    this.resume();
  }

  setCursor(point: Point): void {
    this.cursor = { x: point.x, y: point.y };
  }

  private insidePad(point: Point): boolean {
    return (
      Math.abs(point.x) <= this.widthMm / 2 &&
      Math.abs(point.y) <= this.heightMm / 2
    );
  }
}

/**
 * Simple deterministic transfer curve useful for standalone simulation and
 * calibration experiments. PointerController intentionally owns its own
 * pixelsPerMm output calibration and therefore only uses finger tracking.
 */
export function createVelocityGainTransfer(
  basePixelsPerMm = 8,
  velocityGain = 0.003,
): TouchpadTransferFunction {
  return (deltaMm, velocity) => {
    const speed = Math.hypot(velocity.x, velocity.y);
    const gain = basePixelsPerMm * (1 + speed * velocityGain);
    return { x: deltaMm.x * gain, y: deltaMm.y * gain };
  };
}
