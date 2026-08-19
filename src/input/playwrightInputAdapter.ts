import type { Page } from 'playwright-core';
import type { BrowserInput, MouseButton } from './browserInput.js';
import type { Point } from '../types.js';

/**
 * Browser input adapter backed by Playwright's pointer/keyboard primitives.
 *
 * These APIs route input through the browser automation stack rather than
 * calling element.dispatchEvent() in page JavaScript. They are suitable for
 * reproducible testing, but this project does not claim hardware provenance
 * or indistinguishability from physical user input.
 */
export class PlaywrightInputAdapter implements BrowserInput {
  constructor(private readonly page: Page) {}

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
