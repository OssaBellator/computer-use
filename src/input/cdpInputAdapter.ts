import type { CdpSessionLike } from '../browser/cdpIdentity.js';
import type { Point } from '../types.js';
import type { BrowserInput, MouseButton } from './browserInput.js';

interface KeyDescriptor {
  key: string;
  code: string;
  virtualKeyCode: number;
  text?: string;
  unmodifiedText?: string;
  location?: number;
  modifier?: number;
  requiresShift?: boolean;
}

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const TEXT_SUPPRESSING_MODIFIERS = MODIFIER_BITS.Alt | MODIFIER_BITS.Control | MODIFIER_BITS.Meta;
const KEY_MAP: Record<string, KeyDescriptor> = {
  Tab: { key: 'Tab', code: 'Tab', virtualKeyCode: 9 },
  Enter: { key: 'Enter', code: 'Enter', virtualKeyCode: 13, text: '\r', unmodifiedText: '\r' },
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
  ' ': { key: ' ', code: 'Space', virtualKeyCode: 32, text: ' ', unmodifiedText: ' ' },
  Shift: { key: 'Shift', code: 'ShiftLeft', virtualKeyCode: 16, location: 1, modifier: MODIFIER_BITS.Shift },
  Control: { key: 'Control', code: 'ControlLeft', virtualKeyCode: 17, location: 1, modifier: MODIFIER_BITS.Control },
  Alt: { key: 'Alt', code: 'AltLeft', virtualKeyCode: 18, location: 1, modifier: MODIFIER_BITS.Alt },
  Meta: { key: 'Meta', code: 'MetaLeft', virtualKeyCode: 91, location: 1, modifier: MODIFIER_BITS.Meta },
};
const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4 };

// Deterministic US-keyboard profile for reproducible tests. This is deliberately
// explicit rather than pretending to infer a host operating-system layout.
const UNSHIFTED_PUNCTUATION: Record<string, [string, number]> = {
  '`': ['Backquote', 192], '-': ['Minus', 189], '=': ['Equal', 187],
  '[': ['BracketLeft', 219], ']': ['BracketRight', 221], '\\': ['Backslash', 220],
  ';': ['Semicolon', 186], "'": ['Quote', 222], ',': ['Comma', 188],
  '.': ['Period', 190], '/': ['Slash', 191],
};
const SHIFTED_PUNCTUATION: Record<string, [string, number, string]> = {
  '~': ['Backquote', 192, '`'], '!': ['Digit1', 49, '1'], '@': ['Digit2', 50, '2'],
  '#': ['Digit3', 51, '3'], '$': ['Digit4', 52, '4'], '%': ['Digit5', 53, '5'],
  '^': ['Digit6', 54, '6'], '&': ['Digit7', 55, '7'], '*': ['Digit8', 56, '8'],
  '(': ['Digit9', 57, '9'], ')': ['Digit0', 48, '0'], '_': ['Minus', 189, '-'],
  '+': ['Equal', 187, '='], '{': ['BracketLeft', 219, '['], '}': ['BracketRight', 221, ']'],
  '|': ['Backslash', 220, '\\'], ':': ['Semicolon', 186, ';'], '"': ['Quote', 222, "'"],
  '<': ['Comma', 188, ','], '>': ['Period', 190, '.'], '?': ['Slash', 191, '/'],
};
const SHIFTED_FROM_BASE = Object.fromEntries(
  Object.entries(SHIFTED_PUNCTUATION).map(([shifted, [, , base]]) => [base, shifted]),
) as Record<string, string>;

function printableDescriptor(character: string): KeyDescriptor {
  if (/^[a-z]$/.test(character)) {
    const upper = character.toUpperCase();
    return {
      key: character,
      code: `Key${upper}`,
      virtualKeyCode: upper.charCodeAt(0),
      text: character,
      unmodifiedText: character,
    };
  }
  if (/^[A-Z]$/.test(character)) {
    return {
      key: character,
      code: `Key${character}`,
      virtualKeyCode: character.charCodeAt(0),
      text: character,
      unmodifiedText: character.toLowerCase(),
      requiresShift: true,
    };
  }
  if (/^[0-9]$/.test(character)) {
    return {
      key: character,
      code: `Digit${character}`,
      virtualKeyCode: character.charCodeAt(0),
      text: character,
      unmodifiedText: character,
    };
  }
  const plain = UNSHIFTED_PUNCTUATION[character];
  if (plain) {
    return {
      key: character,
      code: plain[0],
      virtualKeyCode: plain[1],
      text: character,
      unmodifiedText: character,
    };
  }
  const shifted = SHIFTED_PUNCTUATION[character];
  if (shifted) {
    return {
      key: character,
      code: shifted[0],
      virtualKeyCode: shifted[1],
      text: character,
      unmodifiedText: shifted[2],
      requiresShift: true,
    };
  }
  return {
    key: character,
    code: 'Unidentified',
    virtualKeyCode: character.codePointAt(0) ?? 0,
    text: character,
    unmodifiedText: character,
  };
}

function descriptorFor(key: string, shiftActive = false): KeyDescriptor {
  if (KEY_MAP[key]) return KEY_MAP[key];
  if (Array.from(key).length !== 1) return { key, code: key, virtualKeyCode: 0 };
  let resolved = key;
  if (shiftActive && /^[a-z]$/.test(key)) resolved = key.toUpperCase();
  else if (shiftActive && SHIFTED_FROM_BASE[key]) resolved = SHIFTED_FROM_BASE[key];
  return printableDescriptor(resolved);
}

function finitePoint(name: string, point: Point): void {
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    throw new Error(`${name} coordinates must be finite`);
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * BrowserInput adapter backed by Chrome DevTools Protocol Input.* commands for
 * reproducible Chromium interaction tests. It does not synthesize page-side DOM
 * events and does not make claims about physical hardware origin.
 */
export class CdpInputAdapter implements BrowserInput {
  private modifiers = 0;
  private buttons = 0;
  private pointer: Point = { x: 0, y: 0 };

  constructor(private readonly session: CdpSessionLike) {}

  async movePointer(point: Point): Promise<void> {
    finitePoint('pointer', point);
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: point.x, y: point.y,
      modifiers: this.modifiers, buttons: this.buttons,
    });
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
    const isModifier = key in MODIFIER_BITS;
    const descriptor = descriptorFor(
      key,
      (this.modifiers & MODIFIER_BITS.Shift) !== 0 && !isModifier,
    );
    if (descriptor.modifier) this.modifiers |= descriptor.modifier;
    const suppressText = (this.modifiers & TEXT_SUPPRESSING_MODIFIERS) !== 0;
    const text = suppressText ? undefined : descriptor.text;
    await this.session.send('Input.dispatchKeyEvent', {
      type: text !== undefined ? 'keyDown' : 'rawKeyDown',
      key: descriptor.key,
      code: descriptor.code,
      ...(text !== undefined
        ? { text, unmodifiedText: descriptor.unmodifiedText ?? text }
        : {}),
      windowsVirtualKeyCode: descriptor.virtualKeyCode,
      location: descriptor.location ?? 0,
      modifiers: this.modifiers,
    });
  }

  async keyUp(key: string): Promise<void> {
    const isModifier = key in MODIFIER_BITS;
    const descriptor = descriptorFor(
      key,
      (this.modifiers & MODIFIER_BITS.Shift) !== 0 && !isModifier,
    );
    if (descriptor.modifier) this.modifiers &= ~descriptor.modifier;
    await this.session.send('Input.dispatchKeyEvent', {
      type: 'keyUp', key: descriptor.key, code: descriptor.code,
      windowsVirtualKeyCode: descriptor.virtualKeyCode,
      location: descriptor.location ?? 0, modifiers: this.modifiers,
    });
  }

  async pressKey(key: string): Promise<void> {
    const parts = key.split('+').filter(Boolean);
    const main = parts.pop();
    if (!main) return;
    const held = parts.filter((part) => part in MODIFIER_BITS);
    const descriptor = descriptorFor(main);
    if (
      descriptor.requiresShift &&
      !held.includes('Shift') &&
      (this.modifiers & MODIFIER_BITS.Shift) === 0
    ) {
      held.push('Shift');
    }
    for (const modifier of held) await this.keyDown(modifier);
    await this.keyDown(main);
    await this.keyUp(main);
    for (const modifier of held.reverse()) await this.keyUp(modifier);
  }

  async typeText(text: string, delayMs = 0): Promise<void> {
    for (const character of Array.from(text)) {
      if (character === '\n') await this.pressKey('Enter');
      else await this.pressKey(character);
      if (delayMs > 0) await sleep(delayMs);
    }
  }

  async insertText(text: string): Promise<void> {
    await this.session.send('Input.insertText', { text });
  }

  async scroll(delta: Point): Promise<void> {
    await this.session.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: this.pointer.x, y: this.pointer.y,
      deltaX: delta.x, deltaY: delta.y,
      modifiers: this.modifiers, buttons: this.buttons,
    });
  }
}
