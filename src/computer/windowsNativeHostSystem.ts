import { TextEncoder } from 'node:util';
import type { WindowsNativeHostProtocolClient } from './windowsNativeHostProtocol.js';
import type { WindowsVirtualDesktopBounds } from './windowsSendInputPlan.js';
import { captureWindowsUiaWindowRef, type WindowsUiaWindowRef } from './windowsUiaContract.js';

const MAX_WINDOWS=10_000;
const MAX_TEXT_BYTES=1_000_000;
const MAX_TITLE_BYTES=4_096;
const MAX_COORDINATE=1_000_000;
const encoder=new TextEncoder();

export interface WindowsNativeWindowSnapshot {
  readonly window:WindowsUiaWindowRef;
  readonly title:string;
  readonly foreground:boolean;
  readonly bounds:Readonly<{x:number;y:number;width:number;height:number}>;
}
export interface WindowsNativeWindowObservation {
  readonly windows:readonly WindowsNativeWindowSnapshot[];
  readonly truncated:boolean;
  readonly itemCount:number;
  readonly textBytes:number;
}

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
function captureArray(value:unknown,max:number):readonly unknown[]|undefined {
  if(!Array.isArray(value))return undefined;
  try{
    if(Object.getPrototypeOf(value)!==Array.prototype||value.length>max)return undefined;
    const result:unknown[]=[];
    for(let i=0;i<value.length;i++){
      const descriptor=Object.getOwnPropertyDescriptor(value,String(i));
      if(!descriptor||!('value' in descriptor)||descriptor.get!==undefined||descriptor.set!==undefined||!descriptor.enumerable)return undefined;
      result.push(descriptor.value);
    }
    return Object.freeze(result);
  }catch{return undefined;}
}
function finite(value:unknown):value is number {
  return typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=MAX_COORDINATE;
}
function bounds(value:unknown):WindowsNativeWindowSnapshot['bounds']|undefined {
  const raw=captureOwnDataObject(value,['x','y','width','height']);
  if(!raw||!finite(raw.x)||!finite(raw.y)||!finite(raw.width)||!finite(raw.height)||raw.width<0||raw.height<0)return undefined;
  return Object.freeze({x:raw.x,y:raw.y,width:raw.width,height:raw.height});
}
function snapshot(value:unknown):WindowsNativeWindowSnapshot|undefined {
  const raw=captureOwnDataObject(value,['window','title','foreground','bounds']);
  if(!raw||typeof raw.title!=='string'||raw.title.includes('\0')||encoder.encode(raw.title).byteLength>MAX_TITLE_BYTES||typeof raw.foreground!=='boolean')return undefined;
  const window=captureWindowsUiaWindowRef(raw.window);
  const rectangle=bounds(raw.bounds);
  if(!window||!rectangle)return undefined;
  return Object.freeze({window,title:raw.title,foreground:raw.foreground,bounds:rectangle});
}

export class WindowsNativeHostSystemObserver {
  constructor(readonly protocol:WindowsNativeHostProtocolClient) {}

  async observeWindows(limits:{readonly maxItems:number;readonly maxTextBytes:number}):Promise<WindowsNativeWindowObservation>{
    if(!Number.isSafeInteger(limits.maxItems)||limits.maxItems<1||limits.maxItems>MAX_WINDOWS||
       !Number.isSafeInteger(limits.maxTextBytes)||limits.maxTextBytes<1||limits.maxTextBytes>MAX_TEXT_BYTES){
      throw new Error('windows-native-host-window-limits-invalid');
    }
    const raw=captureOwnDataObject(await this.protocol.call('system.windows',Object.freeze(limits)),['windows','truncated','itemCount','textBytes']);
    if(!raw||typeof raw.truncated!=='boolean'||!Number.isSafeInteger(raw.itemCount)||!Number.isSafeInteger(raw.textBytes)||
       (raw.itemCount as number)<0||(raw.textBytes as number)<0||(raw.itemCount as number)>limits.maxItems||(raw.textBytes as number)>limits.maxTextBytes){
      throw new Error('windows-native-host-window-response-invalid');
    }
    const values=captureArray(raw.windows,limits.maxItems);
    if(!values)throw new Error('windows-native-host-window-response-invalid');
    const windows:WindowsNativeWindowSnapshot[]=[];
    let textBytes=0;
    let foreground=0;
    for(const value of values){
      const item=snapshot(value);
      if(!item)throw new Error('windows-native-host-window-response-invalid');
      windows.push(item);
      textBytes+=encoder.encode(item.title).byteLength;
      if(item.foreground)foreground+=1;
    }
    if(windows.length!==raw.itemCount||textBytes!==raw.textBytes||foreground>1){
      throw new Error('windows-native-host-window-response-invalid');
    }
    return Object.freeze({windows:Object.freeze(windows),truncated:raw.truncated,itemCount:raw.itemCount,textBytes:raw.textBytes});
  }

  async observeVirtualDesktop():Promise<WindowsVirtualDesktopBounds>{
    const raw=captureOwnDataObject(await this.protocol.call('system.virtual-desktop',Object.freeze({})),['left','top','width','height']);
    if(!raw||!finite(raw.left)||!finite(raw.top)||!Number.isSafeInteger(raw.width)||!Number.isSafeInteger(raw.height)||
       (raw.width as number)<1||(raw.height as number)<1||(raw.width as number)>MAX_COORDINATE||(raw.height as number)>MAX_COORDINATE){
      throw new Error('windows-native-host-virtual-desktop-response-invalid');
    }
    return Object.freeze({left:raw.left,top:raw.top,width:raw.width,height:raw.height});
  }
}
