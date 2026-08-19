import type { Point } from '../types.js';

export type FingerState = 'idle' | 'contact' | 'moving' | 'lifted' | 'recentering';

export interface TouchpadTransferFunction {
  (deltaMm: Point, velocityMmPerSecond: Point): Point;
}

export interface TouchpadStepResult {
  boundaryReached: boolean;
  finger: Point;
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

  applyFingerDelta(
    deltaMm: Point,
    velocityMmPerSecond: Point = { x: 0, y: 0 },
  ): TouchpadStepResult {
    if (!this.canApplyFingerDelta(deltaMm)) {
      return {
        boundaryReached: true,
        finger: { ...this.finger },
        cursor: { ...this.cursor },
        cursorDelta: { x: 0, y: 0 },
      };
    }

    this.state = 'moving';
    this.finger = {
      x: this.finger.x + deltaMm.x,
      y: this.finger.y + deltaMm.y,
    };

    const cursorDelta = this.transferFunction(deltaMm, velocityMmPerSecond);
    this.cursor = {
      x: this.cursor.x + cursorDelta.x,
      y: this.cursor.y + cursorDelta.y,
    };

    return {
      boundaryReached: false,
      finger: { ...this.finger },
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
    this.cursor = { ...point };
  }

  private insidePad(point: Point): boolean {
    return (
      Math.abs(point.x) <= this.widthMm / 2 &&
      Math.abs(point.y) <= this.heightMm / 2
    );
  }
}

/**
 * Simple deterministic transfer curve useful for tests and calibration.
 * It deliberately models cursor gain without pretending to reproduce a
 * particular operating system's private pointer-acceleration implementation.
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
