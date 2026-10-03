import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WindowsUiaProviderRuntime,
  type WindowsUiaProviderBridge,
} from '../src/computer/windowsUiaProviderRuntime.js';
import type { WindowsUiaControlRef } from '../src/computer/windowsUiaContract.js';

const ref: WindowsUiaControlRef = Object.freeze({
  window:Object.freeze({hwnd:'0x44',desktopSessionId:'interactive:1',process:Object.freeze({processId:44,startIdentity:'start-44'}),generation:2}),
  runtimeId:Object.freeze([44,1]),
  controlType:'button',
  generation:5,
});

function bridge(overrides:Partial<WindowsUiaProviderBridge> = {}): WindowsUiaProviderBridge {
  const element = Object.freeze({token:'element-1'});
  return {
    resolveWindow:async()=>({status:'current',root:Object.freeze({token:'root'})}),
    buildCache:async (_root,plan,epoch)=>({
      window:ref.window,
      itemCount:Math.min(1,plan.maxItems),
      textBytes:0,
      truncated:false,
      invalidationEpoch:epoch,
      capturedAtMs:1,
    }),
    resolveControl:async()=>({status:'candidate',element}),
    compareElements:async()=>true,
    snapshotControl:async()=>({status:'current',control:{ref,enabled:true,patterns:Object.freeze(['invoke'])}}),
    performPattern:async()=>({status:'completed',dispatched:true,verified:true}),
    ...overrides,
  };
}

test('provider runtime pushes hard observation bounds into cache plan', async () => {
  let seenItems = 0;
  let seenDepth = 0;
  const runtime = new WindowsUiaProviderRuntime(bridge({
    buildCache:async (_root,plan,epoch)=>{
      seenItems = plan.maxItems;
      seenDepth = plan.maxDepth;
      return {window:ref.window,itemCount:0,textBytes:0,truncated:false,invalidationEpoch:epoch,capturedAtMs:1};
    },
  }));
  await runtime.observeCached(ref.window,{maxItems:7,maxDepth:3,maxTextBytes:99});
  assert.equal(seenItems,7);
  assert.equal(seenDepth,3);
});

test('provider runtime requires CompareElements agreement during revalidation', async () => {
  const runtime = new WindowsUiaProviderRuntime(bridge({compareElements:async()=>false}));
  const result = await runtime.revalidateControl(ref);
  assert.equal(result.status,'stale');
  if (result.status === 'stale') assert.deepEqual(result.evidence,['windows-uia-compare-elements-mismatch']);
});

test('provider runtime refuses semantic dispatch when exact control cannot resolve', async () => {
  let calls = 0;
  const runtime = new WindowsUiaProviderRuntime(bridge({
    resolveControl:async()=>({status:'ambiguous'}),
    performPattern:async()=>{calls+=1;return {status:'completed',dispatched:true};},
  }));
  const result = await runtime.performSemanticAction(ref,{kind:'invoke'},'local-reversible');
  assert.equal(result.dispatched,false);
  assert.equal(result.status,'rejected');
  assert.equal(calls,0);
});

test('provider cache invalidation epoch must be reflected by next cache build', async () => {
  const runtime = new WindowsUiaProviderRuntime(bridge());
  await runtime.observeCached(ref.window,{maxItems:1,maxDepth:1,maxTextBytes:8});
  runtime.invalidate(ref.window,1,'structure-changed');
  const next = await runtime.observeCached(ref.window,{maxItems:1,maxDepth:1,maxTextBytes:8});
  assert.equal(next.invalidationEpoch,1);
});
