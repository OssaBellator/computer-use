import type { WindowsNativeHostProtocolClient } from './windowsNativeHostProtocol.js';
import { captureWindowsUiaWindowRef, sameWindowsUiaWindow, type WindowsUiaWindowRef } from './windowsUiaContract.js';
import {
  decideWindowsWindowAuthority,
  type WindowsWindowAuthorityDecision,
  type WindowsWindowAuthoritySnapshot,
  type WindowsWindowInteractionState,
} from './windowsWindowAuthority.js';

const MAX_WINDOWS=256;
const INTERACTION_STATES = Object.freeze([
  'running',
  'closing',
  'ready-for-user-interaction',
  'blocked-by-modal-window',
  'not-responding',
] as const satisfies readonly WindowsWindowInteractionState[]);

function captureOwnDataObject(value:unknown,allowed:readonly string[]):Readonly<Record<string,unknown>>|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  try{
    const prototype=Object.getPrototypeOf(value);
    if(prototype!==Object.prototype&&prototype!==null)return undefined;
    const result:Record<string,unknown>=Object.create(null);
    for(const key of allowed){
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(descriptor===undefined)continue;
      if(!('value' in descriptor)||descriptor.get!==undefined||descriptor.set!==undefined||!descriptor.enumerable)return undefined;
      result[key]=descriptor.value;
    }
    return Object.freeze(result);
  }catch{return undefined;}
}

function captureArray(value:unknown,max:number):readonly unknown[]|undefined {
  if(!Array.isArray(value))return undefined;
  try{
    if(Object.getPrototypeOf(value)!==Array.prototype||value.length>max)return undefined;
    const result:unknown[]=[];
    for(let index=0;index<value.length;index+=1){
      const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
      if(!descriptor||!('value' in descriptor)||descriptor.get!==undefined||descriptor.set!==undefined||!descriptor.enumerable)return undefined;
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  }catch{return undefined;}
}

function key(window:WindowsUiaWindowRef):string {
  return `${window.desktopSessionId}:${window.hwnd}:${window.process.processId}:${window.process.startIdentity}:${window.generation}`;
}

function captureSnapshot(value:unknown,requested:ReadonlySet<string>):WindowsWindowAuthoritySnapshot|undefined {
  const raw=captureOwnDataObject(value,['window','isModal','isTopmost','interactionState','owner']);
  if(!raw||typeof raw.isModal!=='boolean'||typeof raw.isTopmost!=='boolean'||
     typeof raw.interactionState!=='string'||!INTERACTION_STATES.includes(raw.interactionState as WindowsWindowInteractionState))return undefined;
  const window=captureWindowsUiaWindowRef(raw.window);
  if(!window||!requested.has(key(window)))return undefined;
  let owner:WindowsUiaWindowRef|undefined;
  if(raw.owner!==undefined){
    owner=captureWindowsUiaWindowRef(raw.owner);
    if(!owner||!requested.has(key(owner)))return undefined;
  }
  return Object.freeze({
    window,
    isModal:raw.isModal,
    isTopmost:raw.isTopmost,
    interactionState:raw.interactionState as WindowsWindowInteractionState,
    ...(owner?{owner}:{}),
  });
}

export class WindowsNativeHostWindowAuthority {
  constructor(readonly protocol:WindowsNativeHostProtocolClient) {}

  async observe(windows:readonly WindowsUiaWindowRef[]):Promise<readonly WindowsWindowAuthoritySnapshot[]> {
    if(!Array.isArray(windows)||windows.length<1||windows.length>MAX_WINDOWS)throw new Error('windows-native-window-authority-input-invalid');
    const captured:WindowsUiaWindowRef[]=[];
    const requested=new Set<string>();
    for(const value of windows){
      const window=captureWindowsUiaWindowRef(value);
      if(!window)throw new Error('windows-native-window-authority-input-invalid');
      const id=key(window);
      if(requested.has(id))throw new Error('windows-native-window-authority-input-duplicate');
      requested.add(id);
      captured.push(window);
    }

    const raw=captureOwnDataObject(await this.protocol.call('uia.window-states',Object.freeze({windows:Object.freeze(captured)})),['states','itemCount']);
    if(!raw||!Number.isSafeInteger(raw.itemCount)||(raw.itemCount as number)<0||(raw.itemCount as number)>captured.length){
      throw new Error('windows-native-window-authority-response-invalid');
    }
    const values=captureArray(raw.states,captured.length);
    if(!values||values.length!==raw.itemCount)throw new Error('windows-native-window-authority-response-invalid');

    const states:WindowsWindowAuthoritySnapshot[]=[];
    const seen=new Set<string>();
    for(const value of values){
      const state=captureSnapshot(value,requested);
      if(!state)throw new Error('windows-native-window-authority-response-invalid');
      const id=key(state.window);
      if(seen.has(id))throw new Error('windows-native-window-authority-response-invalid');
      seen.add(id);
      states.push(state);
    }
    return Object.freeze(states);
  }

  async decide(requested:WindowsUiaWindowRef,windows:readonly WindowsUiaWindowRef[]):Promise<WindowsWindowAuthorityDecision> {
    const requestedSnapshot=captureWindowsUiaWindowRef(requested);
    if(!requestedSnapshot)throw new Error('windows-native-window-authority-requested-invalid');
    if(!windows.some(window=>sameWindowsUiaWindow(window,requestedSnapshot)))throw new Error('windows-native-window-authority-requested-not-in-batch');
    const states=await this.observe(windows);
    return decideWindowsWindowAuthority(requestedSnapshot,states);
  }

  static sameWindow(a:WindowsUiaWindowRef,b:WindowsUiaWindowRef):boolean {
    return sameWindowsUiaWindow(a,b);
  }
}
