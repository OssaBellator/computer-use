import type { CdpSessionLike } from '../browser/cdpIdentity.js';
import type { Point } from '../types.js';
import type { BrowserInput, MouseButton } from './browserInput.js';

interface KeyDescriptor {
  key: string;
  code: string;
  virtualKeyCode: number;
  text?: string;
  location?: number;
  modifier?: number;
}

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const KEY_MAP: Record<string, KeyDescriptor> = {
  Tab: { key: 'Tab', code: 'Tab', virtualKeyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r' },
  Escape: { key: 'Escape', code: 'Escape', virtualKeyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', virtualKeyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', virtualKeyCode: 46 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', virtualKeyCode: 37 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', virtualKeyCode: 38 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', virtualKeyCode: 39 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', virtualKeyCode: 40 },
  Home: { key: 'Home', code: 'Home', virtualKeyCode: 36 },
  End: { key: 'End', code: 'End', virtualKeyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', virtualKeyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', virtualKeyCode: 34 },
  ' ': { key: ' ', code: 'Space', virtualKeyCode: 32, text: ' ' },
  Shift: { key: 'Shift', code: 'ShiftLeft', virtualKeyCode: 16, location: 1, modifier: MODIFIER_BITS.Shift },
  Control: { key: 'Control', code: 'ControlLeft', virtualKeyCode: 17, location: 1, modifier: MODIFIER_BITS.Control },
  Alt: { key: 'Alt', code: 'AltLeft', virtualKeyCode: 18, location: 1, modifier: MODIFIER_BITS.Alt },
  Meta: { key: 'Meta', code: 'MetaLeft', virtualKeyCode: 91, location: 1, modifier: MODIFIER_BITS.Meta },
};
const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

function printableDescriptor(character: string): KeyDescriptor {
  const upper = character.toUpperCase();
  if (/^[A-Z]$/.test(upper)) {
    return { key: character, code: `Key${upper}`, virtualKeyCode: upper.charCodeAt(0), text: character };
  }
  if (/^[0-9]$/.test(character)) {
    return { key: character, code: `Digit${character}`, virtualKeyCode: character.charCodeAt(0), text: character };
  }
  return { key: character, code: 'Unidentified', virtualKeyCode: character.codePointAt(0) ?? 0, text: character };
}

function descriptorFor(key: string): KeyDescriptor {
  return KEY_MAP[key] ?? (Array.from(key).length === 1 ? printableDescriptor(key) : {
    key, code: key, virtualKeyCode: 0,
  });
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * BrowserInput adapter backed by Chrome DevTools Protocol Input.* commands.
 * It uses Chromium's browser input pipeline directly; it does not synthesize
 * page-side DOM events and does not make claims about physical hardware origin.
 */
export class CdpInputAdapter implements BrowserInput {
  private modifiers = 0;
  private buttons = 0;
  private pointer: Point = { x: 0, y: 0 };

  constructor(private readonly session: CdpSessionLike) {}

  async movePointer(point: Point): Promise<void> {
    this.pointer = { ...point };
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y,
      modifiers: this.modifiers, buttons: this.buttons,
    });
  }

  async pointerDown(button: MouseButton = 'left'): Promise<void> {
    this.buttons |= BUTTON_BITS[button];
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: this.pointer.x, y: this.pointer.y,
      button, buttons: this.buttons, clickCount: 1, modifiers: this.modifiers,
    });
  }

  async pointerUp(button: MouseButton = 'left'): Promise<void> {
    this.buttons &= ~BUTTON_BITS[button];
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: this.pointer.x, y: this.pointer.y,
      button, buttons: this.buttons, clickCount: 1, modifiers: this.modifiers,
    });
  }

  async keyDown(key: string): Promise<void> {
    const descriptor = descriptorFor(key);
    if (descriptor.modifier) this.modifiers |= descriptor.modifier;
    await this.session.send('Input.dispatchKeyEvent', {
      type: descriptor.text ? 'keyDown' : 'rawKeyDown',
      key: descriptor.key, code: descriptor.code,
      text: descriptor.text, unmodifiedText: descriptor.text,
      windowsVirtualKeyCode: descriptor.virtualKeyCode,
      nativeVirtualKeyCode: descriptor.virtualKeyCode,
      location: descriptor.location ?? 0, modifiers: this.modifiers,
    });
  }

  async keyUp(key: string): Promise<void> {
    const descriptor = descriptorFor(key);
    if (descriptor.modifier) this.modifiers &= ~descriptor.modifier;
    await this.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: descriptor.key, code: descriptor.code,
      windowsVirtualKeyCode: descriptor.virtualKeyCode,
      nativeVirtualKeyCode: descriptor.virtualKeyCode,
      location: descriptor.location ?? 0, modifiers: this.modifiers,
    });
  }

  async pressKey(key: string): Promise<void> {
    const parts = key.split('+').filter(Boolean);
    const main = parts.pop();
    if (!main) return;
    const held = parts.filter((part) => part in MODIFIER_BITS);
    for (const modifier of held) await this.keyDown(modifier);
    await this.keyDown(main);
    await this.keyUp(main);
    for (const modifier of held.reverse()) await this.keyUp(modifier);
  }

  async typeText(text: string, delayMs = 0): Promise<void> {
    for (const character of Array.from(text)) {
      if (character === '\n') await this.pressKey('Enter');
      else {
        await this.keyDown(character);
        await this.keyUp(character);
      }
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  async scroll(delta: Point): Promise<void> {
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: this.pointer.x, y: this.pointer.y,
      deltaX: delta.x, deltaY: delta.y,
      modifiers: this.modifiers, buttons: this.buttons,
    });
  }
}
