import type {
  DesktopAbsolutePointerInput,
  DesktopKeyboardInput,
  DesktopRelativePointerInput,
} from './desktopUiBackend.js';
import type { WindowsNativeInputDispatcher, WindowsNativeInputDispatchResult } from './windowsNativeInputGate.js';

export interface WindowsVirtualDesktopBounds {
  readonly left:number;
  readonly top:number;
  readonly width:number;
  readonly height:number;
}

export type WindowsSendInputEvent =
  | {readonly kind:'keyboard-vk';readonly virtualKey:number;readonly keyUp:boolean;readonly extended:boolean}
  | {readonly kind:'keyboard-unicode';readonly codeUnit:number;readonly keyUp:boolean}
  | {readonly kind:'mouse-absolute-move';readonly normalizedX:number;readonly normalizedY:number;readonly virtualDesktop:true}
  | {readonly kind:'mouse-relative-move';readonly dx:number;readonly dy:number}
  | {readonly kind:'mouse-button';readonly button:'left'|'middle'|'right';readonly keyUp:boolean};

export interface WindowsSendInputNativeBridge {
  /** Native implementation converts each typed event to one Win32 INPUT record. */
  sendInput(events:readonly WindowsSendInputEvent[]):Promise<number>;
}

const MAX_INPUT_EVENTS = 4_096;
const MAX_RELATIVE_DELTA = 100_000;
const MAX_VIRTUAL_DESKTOP_MAGNITUDE = 1_000_000;
const MAX_UNICODE_CODE_UNITS = MAX_INPUT_EVENTS / 2;

const NAMED_VIRTUAL_KEYS:Readonly<Record<string,{vk:number;extended?:boolean}>> = Object.freeze({
  backspace:{vk:0x08},tab:{vk:0x09},enter:{vk:0x0d},shift:{vk:0x10},control:{vk:0x11},alt:{vk:0x12},
  pause:{vk:0x13},capslock:{vk:0x14},escape:{vk:0x1b},space:{vk:0x20},pageup:{vk:0x21,extended:true},
  pagedown:{vk:0x22,extended:true},end:{vk:0x23,extended:true},home:{vk:0x24,extended:true},
  arrowleft:{vk:0x25,extended:true},arrowup:{vk:0x26,extended:true},arrowright:{vk:0x27,extended:true},arrowdown:{vk:0x28,extended:true},
  insert:{vk:0x2d,extended:true},delete:{vk:0x2e,extended:true},meta:{vk:0x5b,extended:true},
});
const MODIFIER_KEYS = Object.freeze({alt:'alt',control:'control',meta:'meta',shift:'shift'} as const);

function validFinite(value:number,maxMagnitude:number):boolean {
  return Number.isFinite(value) && Math.abs(value) <= maxMagnitude;
}
function validBounds(bounds:WindowsVirtualDesktopBounds):boolean {
  return validFinite(bounds.left,MAX_VIRTUAL_DESKTOP_MAGNITUDE) && validFinite(bounds.top,MAX_VIRTUAL_DESKTOP_MAGNITUDE) &&
    Number.isSafeInteger(bounds.width) && bounds.width > 0 && bounds.width <= MAX_VIRTUAL_DESKTOP_MAGNITUDE &&
    Number.isSafeInteger(bounds.height) && bounds.height > 0 && bounds.height <= MAX_VIRTUAL_DESKTOP_MAGNITUDE;
}
function normalizeAxis(value:number,origin:number,size:number):number {
  if (size === 1) return 0;
  return Math.round(((value-origin) * 65_535) / (size-1));
}

export function normalizeWindowsVirtualDesktopPoint(
  x:number,
  y:number,
  bounds:WindowsVirtualDesktopBounds,
):Readonly<{x:number;y:number}> {
  if (!validBounds(bounds) || !Number.isSafeInteger(x) || !Number.isSafeInteger(y) ||
      x < bounds.left || y < bounds.top || x >= bounds.left+bounds.width || y >= bounds.top+bounds.height) {
    throw new Error('windows-sendinput-absolute-point-invalid');
  }
  return Object.freeze({x:normalizeAxis(x,bounds.left,bounds.width),y:normalizeAxis(y,bounds.top,bounds.height)});
}

function virtualKey(key:string):{vk:number;extended:boolean}|undefined {
  if (key.length === 1 && /^[a-z0-9]$/i.test(key)) return {vk:key.toUpperCase().charCodeAt(0),extended:false};
  if (/^f(?:[1-9]|1[0-9]|2[0-4])$/i.test(key)) {
    const index = Number(key.slice(1));
    return {vk:0x6f+index,extended:false};
  }
  const named = NAMED_VIRTUAL_KEYS[key.toLowerCase()];
  return named ? {vk:named.vk,extended:named.extended === true} : undefined;
}

function modifierEvents(modifiers:readonly ('alt'|'control'|'meta'|'shift')[]|undefined,keyUp:boolean):WindowsSendInputEvent[] {
  const unique = [...new Set(modifiers ?? [])];
  if (unique.length > 4 || unique.some((key)=>MODIFIER_KEYS[key] === undefined)) throw new Error('windows-sendinput-modifiers-invalid');
  const ordered = keyUp ? [...unique].reverse() : unique;
  return ordered.map((key)=>{
    const resolved = virtualKey(key)!;
    return Object.freeze({kind:'keyboard-vk' as const,virtualKey:resolved.vk,keyUp,extended:resolved.extended});
  });
}

export function compileWindowsKeyboardInput(input:DesktopKeyboardInput):readonly WindowsSendInputEvent[] {
  if (input.kind === 'text') {
    if (input.text.length === 0 || input.text.length > MAX_UNICODE_CODE_UNITS || input.text.includes('\0')) {
      throw new Error('windows-sendinput-text-invalid');
    }
    const events:WindowsSendInputEvent[]=[];
    for (let index=0; index<input.text.length; index+=1) {
      const codeUnit = input.text.charCodeAt(index);
      events.push(Object.freeze({kind:'keyboard-unicode',codeUnit,keyUp:false}));
      events.push(Object.freeze({kind:'keyboard-unicode',codeUnit,keyUp:true}));
    }
    return Object.freeze(events);
  }
  const key = virtualKey(input.key);
  if (!key) throw new Error('windows-sendinput-key-unsupported');
  const keyUp = input.kind === 'key-up';
  const event = Object.freeze({kind:'keyboard-vk' as const,virtualKey:key.vk,keyUp,extended:key.extended});
  const modifiers = modifierEvents(input.modifiers,keyUp);
  const events = keyUp ? [event,...modifiers] : [...modifiers,event];
  if (events.length > MAX_INPUT_EVENTS) throw new Error('windows-sendinput-event-limit');
  return Object.freeze(events);
}

export function compileWindowsAbsolutePointerInput(
  input:DesktopAbsolutePointerInput,
  bounds:WindowsVirtualDesktopBounds,
):readonly WindowsSendInputEvent[] {
  const normalized = normalizeWindowsVirtualDesktopPoint(input.x,input.y,bounds);
  const move = Object.freeze({kind:'mouse-absolute-move' as const,normalizedX:normalized.x,normalizedY:normalized.y,virtualDesktop:true as const});
  if (input.kind === 'move') return Object.freeze([move]);
  if (!input.button) throw new Error('windows-sendinput-pointer-button-required');
  if (input.kind === 'down') return Object.freeze([move,Object.freeze({kind:'mouse-button' as const,button:input.button,keyUp:false})]);
  if (input.kind === 'up') return Object.freeze([move,Object.freeze({kind:'mouse-button' as const,button:input.button,keyUp:true})]);
  return Object.freeze([
    move,
    Object.freeze({kind:'mouse-button' as const,button:input.button,keyUp:false}),
    Object.freeze({kind:'mouse-button' as const,button:input.button,keyUp:true}),
  ]);
}

export function compileWindowsRelativePointerInput(input:DesktopRelativePointerInput):readonly WindowsSendInputEvent[] {
  if (!Number.isSafeInteger(input.dx) || !Number.isSafeInteger(input.dy) ||
      Math.abs(input.dx) > MAX_RELATIVE_DELTA || Math.abs(input.dy) > MAX_RELATIVE_DELTA) {
    throw new Error('windows-sendinput-relative-delta-invalid');
  }
  return Object.freeze([Object.freeze({kind:'mouse-relative-move' as const,dx:input.dx,dy:input.dy})]);
}

/** One dispatcher instance represents exactly one SendInput call. */
export class WindowsSendInputDispatcher implements WindowsNativeInputDispatcher {
  private used = false;
  constructor(readonly bridge:WindowsSendInputNativeBridge,readonly events:readonly WindowsSendInputEvent[]) {
    if (!Array.isArray(events) || events.length < 1 || events.length > MAX_INPUT_EVENTS) throw new Error('windows-sendinput-event-count-invalid');
  }
  async dispatch():Promise<WindowsNativeInputDispatchResult> {
    if (this.used) throw new Error('windows-sendinput-dispatcher-reused');
    this.used = true;
    const insertedEventCount = await this.bridge.sendInput(Object.freeze([...this.events]));
    return Object.freeze({requestedEventCount:this.events.length,insertedEventCount});
  }
}
