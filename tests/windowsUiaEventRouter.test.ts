import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsUiaEventRouter, type WindowsUiaEventBridge } from '../src/computer/windowsUiaEventRouter.js';
import { WindowsUiaProviderRuntime, type WindowsUiaProviderBridge } from '../src/computer/windowsUiaProviderRuntime.js';
import type { WindowsUiaControlRef } from '../src/computer/windowsUiaContract.js';

const ref:WindowsUiaControlRef = Object.freeze({
  window:Object.freeze({hwnd:'0x55',desktopSessionId:'interactive:1',process:Object.freeze({processId:55,startIdentity:'start-55'}),generation:1}),
  runtimeId:Object.freeze([55,1]),controlType:'button',generation:1,
});

function providerBridge():WindowsUiaProviderBridge {
  const element = Object.freeze({token:'element'});
  return {
    resolveWindow:async()=>({status:'current',root:Object.freeze({token:'root'})}),
    buildCache:async(_root,_plan,epoch)=>({window:ref.window,itemCount:0,textBytes:0,truncated:false,invalidationEpoch:epoch,capturedAtMs:1}),
    resolveControl:async()=>({status:'candidate',element}),
    compareElements:async()=>true,
    snapshotControl:async()=>({status:'current',control:{ref,patterns:Object.freeze(['invoke'])}}),
    performPattern:async()=>({status:'completed',dispatched:true}),
  };
}

test('UIA event delivery advances provider epoch but does not dispatch actions', async () => {
  let handler:((event:'structure-changed'|'property-changed'|'focus-changed'|'window-opened'|'window-closed')=>void)|undefined;
  let actionCalls = 0;
  const provider = new WindowsUiaProviderRuntime({...providerBridge(),performPattern:async()=>{actionCalls+=1;return {status:'completed',dispatched:true};}});
  const bridge:WindowsUiaEventBridge = {
    register:async(_registration,onEvent)=>{handler=onEvent;},
    unregister:async()=>{},
  };
  const router = new WindowsUiaEventRouter(bridge,provider);
  await router.register({registrationId:'events-1',window:ref.window,events:['structure-changed','focus-changed']});
  assert.equal(provider.currentEpoch(ref.window),0);
  handler?.('structure-changed');
  assert.equal(provider.currentEpoch(ref.window),1);
  assert.equal(actionCalls,0);
});

test('event registration and removal are serialized and removed handlers lose authority', async () => {
  let handler:((event:'structure-changed'|'property-changed'|'focus-changed'|'window-opened'|'window-closed')=>void)|undefined;
  const calls:string[] = [];
  const provider = new WindowsUiaProviderRuntime(providerBridge());
  const bridge:WindowsUiaEventBridge = {
    register:async(registration,onEvent)=>{calls.push(`register:${registration.registrationId}`);handler=onEvent;},
    unregister:async(id)=>{calls.push(`unregister:${id}`);},
  };
  const router = new WindowsUiaEventRouter(bridge,provider);
  await Promise.all([
    router.register({registrationId:'events-serial',window:ref.window,events:['property-changed']}),
    router.unregister('events-serial'),
  ]);
  assert.deepEqual(calls,['register:events-serial','unregister:events-serial']);
  handler?.('property-changed');
  assert.equal(provider.currentEpoch(ref.window),0);
});
