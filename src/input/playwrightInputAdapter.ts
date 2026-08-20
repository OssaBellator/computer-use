import type { BrowserInput, MouseButton } from './browserInput.js';
import type { Point } from '../types.js';

export interface PlaywrightMouseLike {
  move(x: number, y: number): Promise<void>;
  down(options?: { button?: MouseButton }): Promise<void>;
  up(options?: { button?: MouseButton }): Promise<void>;
  wheel(deltaX: number, deltaY: number): Promise<void>;
}

export interface PlaywrightKeyboardLike {
  press(key: string): Promise<void>;
  down(key: string): Promise<void>;
  up(key: string): Promise<void>;
  type(text: string, options?: { delay?: number }): Promise<void>;
}

export interface PlaywrightPageInputLike {
  mouse: PlaywrightMouseLike;
  keyboard: PlaywrightKeyboardLike;
}

function finitePoint(name: string, point: Point): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`${name} coordinates must be finite`);
  }
}

/**
 * Adapter for the public mouse/keyboard surface exposed by Playwright Page.
 * Structural typing keeps the interaction core independent of a hard runtime
 * dependency on a particular Playwright package version.
 */
export class PlaywrightInputAdapter implements BrowserInput {
  private pointer: Point = { x: 0, y: 0 };

  constructor(private readonly page: PlaywrightPageInputLike) {}

  async movePointer(point: Point): Promise<void> {
    finitePoint('pointer', point);
    await this.page.mouse.move(point.x, point.y);
    this.pointer = { x: point.x, y: point.y };
  }

  async movePointerBy(delta: Point): Promise<void> {
    finitePoint('pointer delta', delta);
    await this.movePointer({
      x: this.pointer.x + delta.x,
      y: this.pointer.y + delta.y,
    });
  }

  async pointerDown(button: MouseButton = 'left'): Promise<void> {
    await this.page.mouse.down({ button });
  }

  async pointerUp(button: MouseButton = 'left'): Promise<void> {
    await this.page.mouse.up({ button });
  }

  async pressKey(key: string): Promise<void> {
    await this.page.keyboard.press(key);
  }

  async keyDown(key: string): Promise<void> {
    await this.page.keyboard.down(key);
  }

  async keyUp(key: string): Promise<void> {
    await this.page.keyboard.up(key);
  }

  async typeText(text: string, delayMs = 0): Promise<void> {
    await this.page.keyboard.type(text, { delay: Math.max(0, delayMs) });
  }

  async scroll(delta: Point): Promise<void> {
    await this.page.mouse.wheel(delta.x, delta.y);
  }
}
