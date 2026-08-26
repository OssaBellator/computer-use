import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsComApartmentExecutor } from '../src/computer/windowsComApartment.js';
import { WindowsUiaMtaBridge, type WindowsUiaMtaNativeClient } from '../src/computer/windowsUiaMtaBridge.js';
import { dispatchWindowsUiaPattern, type WindowsUiaNativePatternInvoker } from '../src/computer/windowsUiaPatternDispatcher.js';
import type { WindowsUiaWindowRef, WindowsUiaControlRef } from '../src/computer/windowsUiaContract.js';

const windowRef:WindowsUiaWindowRef = Object.freeze({
  hwnd:'0x77',desktopSessionId:'interactive:1',process:Object.freeze({processId:71,startIdentity:'p71'}),generation:2,
});
const controlRef:WindowsUiaControlRef = Object.freeze({
  window:windowRef,runtimeId:Object.freeze([1,2,3]),controlType:'Button',generation:4,
});
const element = Object.freeze({token:'native-element-1'});

test('MTA bridge keeps every native call on one apartment token', async () => {
  const seen:string[] = [];
  const host = {
    apartment:'mta' as const,
    threadToken:'uia-mta-1',
    run:async <T>(operation:(context:{readonly apartment:'mta';readonly threadToken:string})=>Promise<T>) => operation({apartment:'mta',threadToken:'uia-mta-1'}),
    dispose:async()=>undefined,
  };
  const apartment = new WindowsComApartmentExecutor(host);
  const client:WindowsUiaMtaNativeClient = {
    resolveWindow:async(ctx)=>{seen.push(ctx.threadToken);return {status:'current',root:element};},
    buildCache:async(ctx,_root,_plan,epoch)=>{seen.push(ctx.threadToken);return {window:windowRef,itemCount:0,textBytes:0,truncated:false,invalidationEpoch:epoch,capturedAtMs:1};},
    resolveControl:async(ctx)=>{seen.push(ctx.threadToken);return {status:'candidate',element};},
    compareElements:async(ctx)=>{seen.push(ctx.threadToken);return true;},
    snapshotControl:async(ctx)=>{seen.push(ctx.threadToken);return {status:'current',control:{ref:controlRef,patterns:['invoke']}};},
    performPattern:async(ctx)=>{seen.push(ctx.threadToken);return {status:'completed',dispatched:true};},
  };
  const bridge = new WindowsUiaMtaBridge(apartment,client);
  await bridge.resolveWindow(windowRef);
  await bridge.buildCache(element,{treeScope:'element-and-children',controlViewOnly:true,elementMode:'full',properties:[],patterns:[],maxItems:1,maxDepth:1,maxTextBytes:1},0);
  await bridge.resolveControl(controlRef);
  await bridge.compareElements(element,element);
  await bridge.snapshotControl(element,controlRef);
  await bridge.performPattern(element,{kind:'invoke'},'local-reversible');
  assert.deepEqual(seen,['uia-mta-1','uia-mta-1','uia-mta-1','uia-mta-1','uia-mta-1','uia-mta-1']);
  await apartment.dispose();
});

test('typed pattern dispatcher maps window state and close separately', async () => {
  const calls:string[] = [];
  const ok = async()=>({status:'invoked' as const});
  const invoker:WindowsUiaNativePatternInvoker = {
    invoke:async()=>ok(),setValue:async()=>ok(),toggle:async()=>ok(),select:async()=>ok(),setExpandCollapseState:async()=>ok(),scroll:async()=>ok(),setRangeValue:async()=>ok(),
    setWindowVisualState:async(_element,state)=>{calls.push(state);return ok();},
    closeWindow:async()=>{calls.push('close');return ok();},
  };
  const minimized = await dispatchWindowsUiaPattern(invoker,element,{kind:'window',operation:'minimize'});
  const restored = await dispatchWindowsUiaPattern(invoker,element,{kind:'window',operation:'restore'});
  const closed = await dispatchWindowsUiaPattern(invoker,element,{kind:'window',operation:'close'});
  assert.equal(minimized.dispatched,true);
  assert.equal(restored.dispatched,true);
  assert.equal(closed.dispatched,true);
  assert.deepEqual(calls,['minimized','normal','close']);
});

test('unsupported pattern is known not-dispatched while thrown native call remains uncertain upstream', async () => {
  const unsupported = async()=>({status:'unsupported' as const,evidence:['pattern-unavailable']});
  const invoker:WindowsUiaNativePatternInvoker = {
    invoke:unsupported,setValue:unsupported,toggle:unsupported,select:unsupported,setExpandCollapseState:unsupported,scroll:unsupported,setRangeValue:unsupported,setWindowVisualState:unsupported,closeWindow:unsupported,
  };
  const result = await dispatchWindowsUiaPattern(invoker,element,{kind:'invoke'});
  assert.deepEqual({status:result.status,dispatched:result.dispatched},{status:'unsupported',dispatched:false});
  assert.deepEqual(result.evidence,['pattern-unavailable']);
});
