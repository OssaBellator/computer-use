import { WINDOWS_UIA_INVALIDATION_EVENTS, type WindowsUiaEventBridge, type WindowsUiaEventRegistration, type WindowsUiaInvalidationEvent } from './windowsUiaEventRouter.js';
import type { WindowsNativeHostProtocolClient } from './windowsNativeHostProtocol.js';

const MAX_POLL_EVENTS=64;
const REGISTRATION_ID=/^[a-z0-9][a-z0-9._:-]{0,127}$/;

type Sleep=(milliseconds:number)=>Promise<void>;
interface ActiveRegistration {
  active:boolean;
  readonly registration:WindowsUiaEventRegistration;
  readonly onEvent:(event:WindowsUiaInvalidationEvent)=>void;
  loop:Promise<void>;
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
function captureEvents(value:unknown):readonly WindowsUiaInvalidationEvent[]|undefined {
  if(!Array.isArray(value))return undefined;
  try{
    if(Object.getPrototypeOf(value)!==Array.prototype||value.length>MAX_POLL_EVENTS)return undefined;
    const result:WindowsUiaInvalidationEvent[]=[];
    for(let index=0;index<value.length;index+=1){
      const descriptor=Object.getOwnPropertyDescriptor(value,String(index));
      if(!descriptor||!('value' in descriptor)||descriptor.get!==undefined||descriptor.set!==undefined||!descriptor.enumerable)return undefined;
      if(typeof descriptor.value!=='string'||!WINDOWS_UIA_INVALIDATION_EVENTS.includes(descriptor.value as WindowsUiaInvalidationEvent))return undefined;
      result.push(descriptor.value as WindowsUiaInvalidationEvent);
    }
    return Object.freeze(result);
  }catch{return undefined;}
}
const defaultSleep:Sleep=(milliseconds)=>new Promise(resolve=>setTimeout(resolve,milliseconds));

/**
 * Polls the request/response-only native host for UIA invalidation codes. Native
 * callbacks never become action evidence; they only flow into the existing epoch
 * router. Poll failures conservatively invalidate once and keep retrying while
 * the registration remains active.
 */
export class WindowsNativeHostUiaEventBridge implements WindowsUiaEventBridge {
  private readonly active=new Map<string,ActiveRegistration>();

  constructor(
    readonly protocol:WindowsNativeHostProtocolClient,
    readonly threadToken:string,
    private readonly pollIntervalMs=50,
    private readonly sleep:Sleep=defaultSleep,
  ) {
    if(!REGISTRATION_ID.test(threadToken))throw new Error('windows-native-host-uia-event-thread-token-invalid');
    if(!Number.isSafeInteger(pollIntervalMs)||pollIntervalMs<10||pollIntervalMs>10_000)throw new Error('windows-native-host-uia-event-poll-interval-invalid');
  }

  async register(registration:WindowsUiaEventRegistration,onEvent:(event:WindowsUiaInvalidationEvent)=>void):Promise<void>{
    if(!REGISTRATION_ID.test(registration.registrationId)||this.active.has(registration.registrationId)||registration.events.length===0){
      throw new Error('windows-native-host-uia-event-registration-invalid');
    }
    const raw=captureOwnDataObject(await this.protocol.call('uia.events.register',Object.freeze({
      threadToken:this.threadToken,
      registrationId:registration.registrationId,
      window:registration.window,
      events:Object.freeze([...registration.events]),
    })),['registered']);
    if(!raw||raw.registered!==true)throw new Error('windows-native-host-uia-event-register-response-invalid');

    const state:ActiveRegistration={active:true,registration,onEvent,loop:Promise.resolve()};
    this.active.set(registration.registrationId,state);
    state.loop=this.pollLoop(state);
  }

  async unregister(registrationId:string):Promise<void>{
    const state=this.active.get(registrationId);
    if(!state)return;
    state.active=false;
    this.active.delete(registrationId);
    const raw=captureOwnDataObject(await this.protocol.call('uia.events.unregister',Object.freeze({
      threadToken:this.threadToken,
      registrationId,
    })),['unregistered']);
    if(!raw||typeof raw.unregistered!=='boolean')throw new Error('windows-native-host-uia-event-unregister-response-invalid');
    await state.loop;
  }

  private async pollLoop(state:ActiveRegistration):Promise<void>{
    let failureInvalidated=false;
    while(state.active){
      try{
        const raw=captureOwnDataObject(await this.protocol.call('uia.events.poll',Object.freeze({
          threadToken:this.threadToken,
          registrationId:state.registration.registrationId,
          maxEvents:MAX_POLL_EVENTS,
        })),['events','more']);
        const events=raw?captureEvents(raw.events):undefined;
        if(!raw||!events||typeof raw.more!=='boolean')throw new Error('windows-native-host-uia-event-poll-response-invalid');
        if(!state.active)break;
        failureInvalidated=false;
        for(const event of events){
          if(!state.active)break;
          state.onEvent(event);
        }
        if(raw.more===true)continue;
      }catch{
        if(!state.active)break;
        if(!failureInvalidated){
          // Use an invalidation event already authorized by this registration so
          // WindowsUiaEventRouter cannot filter out the conservative freshness loss.
          const fallback=state.registration.events[0];
          if(fallback)state.onEvent(fallback);
          failureInvalidated=true;
        }
      }
      if(state.active)await this.sleep(this.pollIntervalMs);
    }
  }
}
