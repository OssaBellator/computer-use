import type { Point } from '../types.js';

export type MouseButton = 'left' | 'middle' | 'right';

export interface BrowserInput {
  movePointer(point: Point): Promise<void>;
  pointerDown(button?: MouseButton): Promise<void>;
  pointerUp(button?: MouseButton): Promise<void>;
  pressKey(key: string): Promise<void>;
  keyDown(key: string): Promise<void>;
  keyUp(key: string): Promise<void>;
  typeText(text: string, delayMs?: number): Promise<void>;
  scroll(delta: Point): Promise<void>;
}
