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

/**
 * Adapter for the public mouse/keyboard surface exposed by Playwright Page.
 * Structural typing keeps the interaction core independent of a hard runtime
 * dependency on a particular Playwright package version.
 */
export class PlaywrightInputAdapter implements BrowserInput {
  constructor(private readonly page: PlaywrightPageInputLike) {}

  async movePointer(point: Point): Promise<void> {
    await this.page.mouse.move(point.x, point.y);
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
