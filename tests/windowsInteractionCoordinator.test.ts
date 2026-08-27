import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopInteractionLeaseManager } from '../src/computer/desktopInteractionLease.js';
import { observationTrust } from '../src/computer/observationTrust.js';
import { WindowsNativeInputGate } from '../src/computer/windowsNativeInputGate.js';
import { WindowsInteractionCoordinator } from '../src/computer/windowsInteractionCoordinator.js';
import { WindowsUiaSemanticRuntime, type WindowsUiaControlRef, type WindowsUiaProvider, type WindowsUiaWindowRef } from '../src/computer/windowsUiaContract.js';
import { WINDOWS_MANDATORY_INTEGRITY_RIDS } from '../src/computer/windowsProcessIntegrity.js';

const main:WindowsUiaWindowRef = Object.freeze({
  hwnd:'0x500',desktopSessionId:'interactive:1',process:Object.freeze({processId:500,startIdentity:'p500'}),generation:1,
});
const modal:WindowsUiaWindowRef = Object.freeze({
  hwnd:'0x501',desktopSessionId:'interactive:1',process:Object.freeze({processId:500,startIdentity:'p500'}),generation:1,
});
const ref:WindowsUiaControlRef = Object.freeze({window:main,runtimeId:Object.freeze([1,5,0,0]),controlType:'Button',generation:1});
const surface = Object.freeze({adapterId:'desktop:windows',environment:'desktop-ui' as const,surfaceId:'0x500',generation:1});
const frame = Object.freeze({
  window:main,captureGeneration:1,frameSequence:7,capturedAtMs:100,contentWidth:800,contentHeight:600,
  geometry:Object.freeze({left:0,top:0,width:800,height:600,dpi:96}),
});
const binding = Object.freeze({frame,x:100,y:200});

function semanticProvider(onDispatch:()=>void = ()=>undefined):WindowsUiaProvider {
  return {
    observeCached:async(window)=>({window,itemCount:0,textBytes:0,truncated:false,invalidationEpoch:0,capturedAtMs:1}),
    revalidateControl:async(captured)=>({status:'current',control:{ref:captured,enabled:true,patterns:['invoke']}}),
    performSemanticAction:async()=>{onDispatch();return {status:'completed',dispatched:true};},
  };
}

async function coordinator(inputSequence=1, targetRid:number=WINDOWS_MANDATORY_INTEGRITY_RIDS.low) {
  const leases = new DesktopInteractionLeaseManager({snapshot:async()=>({sequence:inputSequence})},()=>100);
  const gate = new WindowsNativeInputGate(leases);
  const runtime = new WindowsUiaSemanticRuntime(semanticProvider());
  const integrity = {
    currentProcessIntegrityRid:async()=>WINDOWS_MANDATORY_INTEGRITY_RIDS.medium,
    processIntegrityRid:async()=>targetRid,
  };
  const value = new WindowsInteractionCoordinator(runtime,gate,integrity);
  const lease = await leases.acquire({leaseId:'coord-lease',mode:'interactive-host',targetDesktop:'desktop-1',targetSurface:surface,durationMs:1000});
  return {value,lease};
}

test('semantic control authority does not leak across modal reroute', async () => {
  let dispatches = 0;
  const leases = new DesktopInteractionLeaseManager({snapshot:async()=>({sequence:1})},()=>100);
  const value = new WindowsInteractionCoordinator(
    new WindowsUiaSemanticRuntime(semanticProvider(()=>{dispatches+=1;})),
    new WindowsNativeInputGate(leases),
    {currentProcessIntegrityRid:async()=>0x2000,processIntegrityRid:async()=>0x2000},
  );
  const result = await value.actSemantic({
    ref,action:{kind:'invoke'},effect:'local-reversible',
    windows:[
      {window:main,isModal:false,interactionState:'blocked-by-modal-window'},
      {window:modal,isModal:true,interactionState:'ready-for-user-interaction',owner:main},
    ],
  });
  assert.equal(result.dispatch,'not-dispatched');
  assert.deepEqual(result.evidence,['windows-window-authority-rerouted-reobserve']);
  assert.equal(dispatches,0);
});

test('visual native input requires same authoritative current frame then passes UIPI and lease', async () => {
  const {value,lease} = await coordinator();
  let dispatches = 0;
  const result = await value.actVisualNative({
    binding,currentFrame:frame,windows:[{window:main,isModal:false,interactionState:'ready-for-user-interaction'}],
    lease,targetDesktop:'desktop-1',targetSurface:surface,effect:'local-reversible',
    dispatcher:{dispatch:async()=>{dispatches+=1;return {requestedEventCount:2,insertedEventCount:2};}},
  });
  assert.equal(result.status,'completed');
  assert.equal(result.dispatch,'dispatched-once');
  assert.equal(dispatches,1);
});

test('stale visual frame fails before integrity read or native dispatch', async () => {
  let tokenReads = 0;
  const leases = new DesktopInteractionLeaseManager({snapshot:async()=>({sequence:1})},()=>100);
  const lease = await leases.acquire({leaseId:'stale-frame',mode:'interactive-host',targetDesktop:'desktop-1',targetSurface:surface,durationMs:1000});
  const value = new WindowsInteractionCoordinator(
    new WindowsUiaSemanticRuntime(semanticProvider()),new WindowsNativeInputGate(leases),
    {currentProcessIntegrityRid:async()=>{tokenReads+=1;return 0x2000;},processIntegrityRid:async()=>{tokenReads+=1;return 0x1000;}},
  );
  let dispatches = 0;
  const result = await value.actVisualNative({
    binding,currentFrame:{...frame,frameSequence:8},windows:[{window:main,isModal:false,interactionState:'running'}],
    lease,targetDesktop:'desktop-1',targetSurface:surface,effect:'local-reversible',
    dispatcher:{dispatch:async()=>{dispatches+=1;return {requestedEventCount:1,insertedEventCount:1};}},
  });
  assert.equal(result.dispatch,'not-dispatched');
  assert.deepEqual(result.evidence,['windows-input-grounding-capture-stale']);
  assert.equal(tokenReads,0);
  assert.equal(dispatches,0);
});

test('modal reroute forces re-grounding before coordinate input', async () => {
  const {value,lease} = await coordinator();
  let dispatches = 0;
  const result = await value.actVisualNative({
    binding,currentFrame:frame,
    windows:[
      {window:main,isModal:false,interactionState:'blocked-by-modal-window'},
      {window:modal,isModal:true,interactionState:'ready-for-user-interaction',owner:main},
    ],
    lease,targetDesktop:'desktop-1',targetSurface:surface,effect:'local-reversible',
    dispatcher:{dispatch:async()=>{dispatches+=1;return {requestedEventCount:1,insertedEventCount:1};}},
  });
  assert.equal(result.dispatch,'not-dispatched');
  assert.deepEqual(result.evidence,['windows-window-authority-rerouted-reground']);
  assert.equal(dispatches,0);
});

test('fresh higher-integrity target blocks native dispatcher', async () => {
  const {value,lease} = await coordinator(1,WINDOWS_MANDATORY_INTEGRITY_RIDS.high);
  let dispatches = 0;
  const result = await value.actVisualNative({
    binding,currentFrame:frame,windows:[{window:main,isModal:false,interactionState:'running'}],
    lease,targetDesktop:'desktop-1',targetSurface:surface,effect:'local-reversible',
    dispatcher:{dispatch:async()=>{dispatches+=1;return {requestedEventCount:1,insertedEventCount:1};}},
  });
  assert.equal(result.status,'unsupported');
  assert.equal(result.dispatch,'not-dispatched');
  assert.deepEqual(result.evidence,['uipi-higher-integrity-target']);
  assert.equal(dispatches,0);
});

test('consequential semantic action is blocked before UIA dispatch without exact authority grant', async () => {
  let dispatches = 0;
  const leases = new DesktopInteractionLeaseManager({snapshot:async()=>({sequence:1})},()=>100);
  const value = new WindowsInteractionCoordinator(
    new WindowsUiaSemanticRuntime(semanticProvider(()=>{dispatches+=1;})),new WindowsNativeInputGate(leases),
    {currentProcessIntegrityRid:async()=>0x2000,processIntegrityRid:async()=>0x2000},
  );
  const denied = await value.actSemantic({
    ref,action:{kind:'invoke'},effect:'external-communication',windows:[{window:main,isModal:false,interactionState:'running'}],
  });
  assert.deepEqual(denied.evidence,['windows-consequence-effect-authority-required']);
  assert.equal(dispatches,0);

  const allowed = await value.actSemantic({
    ref,action:{kind:'invoke'},effect:'external-communication',windows:[{window:main,isModal:false,interactionState:'running'}],
    grants:[{grantId:'user-send',source:observationTrust('user-authored',['user-request']),allowedEffects:['external-communication']}],
  });
  assert.equal(allowed.dispatch,'dispatched-once');
  assert.equal(dispatches,1);
});

test('external screen content cannot authorize a consequential native fallback', async () => {
  const {value,lease} = await coordinator();
  let dispatches = 0;
  const result = await value.actVisualNative({
    binding,currentFrame:frame,windows:[{window:main,isModal:false,interactionState:'running'}],
    lease,targetDesktop:'desktop-1',targetSurface:surface,effect:'external-transaction',
    grants:[{grantId:'screen-pay',source:observationTrust('external-untrusted-content',['screen']),allowedEffects:['external-transaction']}],
    dispatcher:{dispatch:async()=>{dispatches+=1;return {requestedEventCount:1,insertedEventCount:1};}},
  });
  assert.deepEqual(result.evidence,['windows-consequence-authority-source-untrusted']);
  assert.equal(dispatches,0);
});

test('semantic dispatch can be verified only by a fresh authoritative post-action sample',async()=>{
  const {value}=await coordinator();
  let observations=0;
  const result=await value.actSemantic({
    ref,action:{kind:'invoke'},effect:'local-reversible',windows:[{window:main,isModal:false,interactionState:'running'}],
    verification:{
      provider:{observe:async()=>({sequence:2,capturedAtMs:Date.now()+1_000,value:{invoked:true}})},
      predicate:(observation)=>{observations+=1;return observation.value.invoked?'match':'mismatch';},
      options:{minimumSequenceExclusive:1,timeoutMs:0},
    },
  });
  assert.equal(result.status,'completed');
  assert.equal(result.dispatch,'dispatched-once');
  assert.equal(result.verification,'verified');
  assert.equal(observations,1);
  assert.ok(result.evidence?.includes('windows-post-action-verified'));
});

test('coordinator automatically applies conservative built-in UIA verification when normalized post-state exists',async()=>{
  const leases=new DesktopInteractionLeaseManager({snapshot:async()=>({sequence:1})},()=>100);
  let revalidations=0;
  const value=new WindowsInteractionCoordinator(
    new WindowsUiaSemanticRuntime({
      observeCached:async(window)=>({window,itemCount:0,textBytes:0,truncated:false,invalidationEpoch:0,capturedAtMs:1}),
      revalidateControl:async(captured)=>{
        revalidations+=1;
        return {status:'current',control:{ref:captured,value:revalidations===1?'old':'new',enabled:true,patterns:['value']}};
      },
      performSemanticAction:async()=>({status:'completed',dispatched:true}),
    }),
    new WindowsNativeInputGate(leases),
    {currentProcessIntegrityRid:async()=>0x2000,processIntegrityRid:async()=>0x2000},
  );
  const result=await value.actSemantic({
    ref,action:{kind:'set-value',value:'new'},effect:'local-reversible',windows:[{window:main,isModal:false,interactionState:'running'}],
  });
  assert.equal(result.status,'completed');
  assert.equal(result.dispatch,'dispatched-once');
  assert.equal(result.verification,'verified');
  assert.equal(revalidations,2);
});

test('matching post-action observation cannot erase partial native dispatch uncertainty',async()=>{
  const {value,lease}=await coordinator();
  const result=await value.actVisualNative({
    binding,currentFrame:frame,windows:[{window:main,isModal:false,interactionState:'running'}],
    lease,targetDesktop:'desktop-1',targetSurface:surface,effect:'local-reversible',
    dispatcher:{dispatch:async()=>({requestedEventCount:2,insertedEventCount:1})},
    verification:{
      provider:{observe:async()=>({sequence:10,capturedAtMs:Date.now()+1_000,value:'looks-complete'})},
      predicate:()=> 'match',
      options:{minimumSequenceExclusive:9,timeoutMs:0},
    },
  });
  assert.equal(result.status,'unknown');
  assert.equal(result.dispatch,'unknown');
  assert.equal(result.verification,'verified');
  assert.ok(result.evidence?.includes('windows-input-partial-dispatch'));
  assert.ok(result.evidence?.includes('windows-post-action-verified'));
});

test('pre-dispatch rejection never invokes post-action verification provider',async()=>{
  let observations=0;
  const {value}=await coordinator();
  const result=await value.actSemantic({
    ref,action:{kind:'invoke'},effect:'external-communication',windows:[{window:main,isModal:false,interactionState:'running'}],
    verification:{
      provider:{observe:async()=>{observations+=1;return {sequence:1,capturedAtMs:Date.now(),value:true};}},
      predicate:()=> 'match',
    },
  });
  assert.equal(result.dispatch,'not-dispatched');
  assert.equal(observations,0);
});
