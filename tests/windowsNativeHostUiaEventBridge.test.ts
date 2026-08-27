import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsNativeHostProtocolClient } from '../src/computer/windowsNativeHostProtocol.js';
import { WindowsNativeHostUiaEventBridge } from '../src/computer/windowsNativeHostUiaEventBridge.js';
import type { WindowsUiaWindowRef } from '../src/computer/windowsUiaContract.js';

const windowRef:WindowsUiaWindowRef=Object.freeze({
  hwnd:'0x700',desktopSessionId:'session:1',process:Object.freeze({processId:700,startIdentity:'p700'}),generation:3,
});

function protocol(handler:(operation:string,body:unknown)=>unknown|Promise<unknown>){
  let requestSequence=0;
  return new WindowsNativeHostProtocolClient({
    maxMessageBytes:256_000,
    exchange:async request=>({protocol:1,id:request.id,status:'ok',body:await handler(request.operation,request.body)}),
    close:async()=>undefined,
  },{next:()=>`event-${++requestSequence}`});
}
const fastSleep=async()=>{await new Promise(resolve=>setTimeout(resolve,1));};
const settle=async()=>{await new Promise(resolve=>setTimeout(resolve,8));};
const waitUntil=async(predicate:()=>boolean,timeoutMs=100)=>{
  const deadline=Date.now()+timeoutMs;
  while(!predicate()&&Date.now()<deadline)await fastSleep();
};

test('native event bridge polls bounded invalidation codes and stops after unregister', async()=>{
  let polls=0;
  let unregisters=0;
  const p=protocol(operation=>{
    if(operation==='uia.events.register')return {registered:true};
    if(operation==='uia.events.poll'){
      polls+=1;
      return polls===1?{events:['property-changed','structure-changed'],more:false}:{events:[],more:false};
    }
    if(operation==='uia.events.unregister'){unregisters+=1;return {unregistered:true};}
    return {};
  });
  const bridge=new WindowsNativeHostUiaEventBridge(p,'uia-mta-1',10,fastSleep);
  const seen:string[]=[];
  await bridge.register({registrationId:'reg-1',window:windowRef,events:['property-changed','structure-changed']},event=>seen.push(event));
  await settle();
  assert.deepEqual(seen.slice(0,2),['property-changed','structure-changed']);
  await bridge.unregister('reg-1');
  const after=polls;
  await settle();
  assert.equal(polls,after);
  assert.equal(unregisters,1);
});

test('native event polling failure conservatively invalidates once with an authorized event until channel recovers', async()=>{
  let polls=0;
  const p=protocol(operation=>{
    if(operation==='uia.events.register')return {registered:true};
    if(operation==='uia.events.poll'){
      polls+=1;
      if(polls<=2)throw new Error('transport unavailable');
      return {events:['focus-changed'],more:false};
    }
    if(operation==='uia.events.unregister')return {unregistered:true};
    return {};
  });
  const bridge=new WindowsNativeHostUiaEventBridge(p,'uia-mta-2',10,fastSleep);
  const seen:string[]=[];
  await bridge.register({registrationId:'reg-2',window:windowRef,events:['focus-changed']},event=>seen.push(event));
  await waitUntil(()=>seen.length>=2);
  assert.ok(seen.length>=2);
  assert.ok(seen.every(value=>value==='focus-changed'));
  await bridge.unregister('reg-2');
});

test('malformed native event response is never delivered as an invalidation event', async()=>{
  let polls=0;
  const p=protocol(operation=>{
    if(operation==='uia.events.register')return {registered:true};
    if(operation==='uia.events.poll'){
      polls+=1;
      return polls===1?{events:['not-an-event'],more:false}:{events:[],more:false};
    }
    if(operation==='uia.events.unregister')return {unregistered:true};
    return {};
  });
  const bridge=new WindowsNativeHostUiaEventBridge(p,'uia-mta-3',10,fastSleep);
  const seen:string[]=[];
  await bridge.register({registrationId:'reg-3',window:windowRef,events:['structure-changed']},event=>seen.push(event));
  await settle();
  // Malformed channel data causes only the conservative freshness invalidation.
  assert.deepEqual(seen,['structure-changed']);
  await bridge.unregister('reg-3');
});
