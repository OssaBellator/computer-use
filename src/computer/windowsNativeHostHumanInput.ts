import type { HumanInputObserver, HumanInputSnapshot } from './desktopInteractionLease.js';
import type { WindowsNativeHostProtocolClient } from './windowsNativeHostProtocol.js';

function captureOwnDataObject(value:unknown,allowed:readonly string[]):Readonly<Record<string,unknown>>|undefined {
  if(!value||typeof value!=='object'||Array.isArray(value))return undefined;
  try{
    const prototype=Object.getPrototypeOf(value);
    if(prototype!==Object.prototype&&prototype!==null)return undefined;
    const captured:Record<string,unknown>=Object.create(null);
    for(const key of allowed){
      const descriptor=Object.getOwnPropertyDescriptor(value,key);
      if(descriptor===undefined)continue;
      if(!('value' in descriptor)||descriptor.get!==undefined||descriptor.set!==undefined||!descriptor.enumerable)return undefined;
      captured[key]=descriptor.value;
    }
    return Object.freeze(captured);
  }catch{return undefined;}
}

/**
 * Human-input freshness source backed by the native low-level hook monitor.
 * The native sequence advances only for non-injected keyboard/mouse events, so
 * SendInput performed by this same runtime does not invalidate its own lease.
 */
export class WindowsNativeHostHumanInputObserver implements HumanInputObserver {
  constructor(readonly protocol:WindowsNativeHostProtocolClient) {}

  async snapshot():Promise<HumanInputSnapshot>{
    const raw=captureOwnDataObject(await this.protocol.call('input.human-sequence',Object.freeze({})),['sequence']);
    if(!raw||typeof raw.sequence!=='number'||!Number.isSafeInteger(raw.sequence)||raw.sequence<0){
      throw new Error('windows-native-host-human-input-response-invalid');
    }
    return Object.freeze({sequence:raw.sequence});
  }
}
