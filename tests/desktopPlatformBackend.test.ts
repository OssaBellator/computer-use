import test from 'node:test';
import assert from 'node:assert/strict';
import { DesktopUiEnvironmentAdapter, type DesktopSemanticObservationData, type DesktopSystemObservationData } from '../src/computer/desktopUiAdapter.js';
import { PlatformDesktopUiBackend, type DesktopPlatformBridge, type PlatformDesktopDispatch, type PlatformDesktopWindow } from '../src/computer/desktopPlatformBackend.js';
import { computerActionMayAutoRetry, type ComputerEffectClass, type ComputerObservationLimits } from '../src/computer/environmentAdapter.js';
import type { DesktopBackendActionResult, DesktopVisualAcquisitionLimits } from '../src/computer/desktopUiBackend.js';

class ContractBridge implements DesktopPlatformBridge {
  readonly id = 'contract-linux';
  readonly platform = 'linux-atspi' as const;
  readonly supportsRelativePointer = true;
  windows:PlatformDesktopWindow[] = [{nativeId:'native-7',instanceToken:'window-instance-a',title:'Editor',foreground:true,focused:true}];
  controlInstance = 'control-instance-a';
  lastSystemLimits?:Required<ComputerObservationLimits>;
  lastAccessibilityLimits?:Required<ComputerObservationLimits>;
  dispatches:PlatformDesktopDispatch[] = [];
  malformedDispatch = false;
  throwOnDispatch = false;

  async enumerateWindows(limits:Required<ComputerObservationLimits>) {
    this.lastSystemLimits = limits;
    return {windows:this.windows.slice(0,limits.maxItems),truncated:this.windows.length > limits.maxItems,focusedControlNativeId:'native-control-1'};
  }
  async accessibility(window:PlatformDesktopWindow,limits:Required<ComputerObservationLimits>) {
    this.lastAccessibilityLimits = limits;
    return {status:'available' as const,windowInstanceToken:window.instanceToken,root:{nativeId:'root',instanceToken:'root-a',role:'window',children:[{nativeId:'native-control-1',instanceToken:this.controlInstance,role:'button',name:'Save'}]}};
  }
  async visual(window:PlatformDesktopWindow,_limits:DesktopVisualAcquisitionLimits) {
    return {status:'unsupported' as const,windowInstanceToken:window.instanceToken,reason:'host-smoke-not-enabled'};
  }
  async dispatch(action:PlatformDesktopDispatch,_effect:ComputerEffectClass):Promise<DesktopBackendActionResult> {
    this.dispatches.push(action);
    if (this.throwOnDispatch) throw new Error('native helper lost after possible dispatch');
    if (this.malformedDispatch) return null as unknown as DesktopBackendActionResult;
    const liveWindow = this.windows.find((candidate)=>candidate.nativeId === action.target.nativeWindowId);
    if (!liveWindow || liveWindow.instanceToken !== action.target.expectedWindowInstanceToken) return {status:'rejected',dispatched:false,verified:false,evidence:['native-window-stale']};
    if (action.target.nativeControlId && this.controlInstance !== action.target.expectedControlInstanceToken) return {status:'rejected',dispatched:false,verified:false,evidence:['native-control-stale']};
    return {status:'completed',dispatched:true,verified:true,evidence:['native-dispatch-completed']};
  }
}

async function observed(adapter:DesktopUiEnvironmentAdapter) {
  const envelope = await adapter.observe({adapterId:adapter.descriptor.id,channel:'system',limits:{maxItems:8,maxTextBytes:4096,maxDepth:4}});
  return (envelope.data as DesktopSystemObservationData).windows[0]!;
}
function surfaceTarget(adapter:DesktopUiEnvironmentAdapter,window:Awaited<ReturnType<typeof observed>>) {
  return {adapterId:adapter.descriptor.id,environment:'desktop-ui' as const,kind:'surface' as const,entityId:window.nativeWindowId,surfaceId:window.nativeWindowId,generation:window.generation};
}

test('independent platform backend instances never recreate the same public window authority',async()=>{
  const first = new DesktopUiEnvironmentAdapter(new PlatformDesktopUiBackend(new ContractBridge()),'desktop:first');
  const second = new DesktopUiEnvironmentAdapter(new PlatformDesktopUiBackend(new ContractBridge()),'desktop:second');
  const firstWindow = await observed(first);
  const secondWindow = await observed(second);
  assert.notEqual(firstWindow.nativeWindowId,secondWindow.nativeWindowId);
});

test('window native-handle replacement advances generation instead of reusing authority',async()=>{
  const bridge = new ContractBridge();
  const adapter = new DesktopUiEnvironmentAdapter(new PlatformDesktopUiBackend(bridge),'desktop:contract');
  const before = await observed(adapter);
  bridge.windows = [{...bridge.windows[0]!,instanceToken:'window-instance-b'}];
  const after = await observed(adapter);
  assert.equal(after.nativeWindowId,before.nativeWindowId);
  assert.equal(after.generation,before.generation + 1);
  const stale = await adapter.act({adapterId:adapter.descriptor.id,actionId:'focus-old-window',capability:'desktop.focus',effect:'local-reversible',idempotency:'idempotent',target:surfaceTarget(adapter,before)});
  assert.equal(stale.dispatch,'not-dispatched');
  assert.equal(bridge.dispatches.length,0);
});

test('replaced control with recycled native id receives a different stable control id',async()=>{
  const bridge = new ContractBridge();
  const adapter = new DesktopUiEnvironmentAdapter(new PlatformDesktopUiBackend(bridge),'desktop:contract');
  const window = await observed(adapter);
  const first = await adapter.observe({adapterId:adapter.descriptor.id,channel:'semantic-ui',surface:window.surface,limits:{maxItems:8,maxTextBytes:4096,maxDepth:4}});
  const firstControl = (first.data as DesktopSemanticObservationData).root!.children[0]!;
  bridge.controlInstance = 'control-instance-b';
  const second = await adapter.observe({adapterId:adapter.descriptor.id,channel:'semantic-ui',surface:window.surface,limits:{maxItems:8,maxTextBytes:4096,maxDepth:4}});
  const secondControl = (second.data as DesktopSemanticObservationData).root!.children[0]!;
  assert.notEqual(secondControl.entity.entityId,firstControl.entity.entityId);
  const stale = await adapter.act({adapterId:adapter.descriptor.id,actionId:'focus-old-control',capability:'desktop.focus',effect:'local-reversible',idempotency:'idempotent',target:firstControl.entity});
  assert.equal(stale.dispatch,'not-dispatched');
  assert.equal(bridge.dispatches.length,0);
});

test('native acquisition receives caller bounds before enumeration/tree materialization',async()=>{
  const bridge = new ContractBridge();
  bridge.windows = Array.from({length:50},(_,index)=>({nativeId:`w-${index}`,instanceToken:`i-${index}`,title:`Window ${index}`,foreground:index===0,focused:index===0}));
  const adapter = new DesktopUiEnvironmentAdapter(new PlatformDesktopUiBackend(bridge),'desktop:contract');
  const system = await adapter.observe({adapterId:adapter.descriptor.id,channel:'system',limits:{maxItems:2,maxTextBytes:128,maxDepth:2}});
  assert.equal((system.data as DesktopSystemObservationData).windows.length,2);
  assert.equal(bridge.lastSystemLimits?.maxItems,2);
  const window = (system.data as DesktopSystemObservationData).windows[0]!;
  await adapter.observe({adapterId:adapter.descriptor.id,channel:'semantic-ui',surface:window.surface,limits:{maxItems:3,maxTextBytes:96,maxDepth:1}});
  assert.equal(bridge.lastAccessibilityLimits?.maxItems,3);
  assert.equal(bridge.lastAccessibilityLimits?.maxTextBytes,96);
  assert.equal(bridge.lastAccessibilityLimits?.maxDepth,1);
});

test('malformed native dispatch result maps conservatively to unknown',async()=>{
  const bridge = new ContractBridge(); bridge.malformedDispatch = true;
  const adapter = new DesktopUiEnvironmentAdapter(new PlatformDesktopUiBackend(bridge),'desktop:contract');
  const window = await observed(adapter);
  const result = await adapter.act({adapterId:adapter.descriptor.id,actionId:'native-key',capability:'desktop.keyboard',effect:'local-reversible',idempotency:'non-idempotent',target:surfaceTarget(adapter,window),payload:{kind:'key-down',key:'Enter'}});
  assert.equal(result.status,'unknown');
  assert.equal(result.dispatch,'unknown');
  assert.equal(result.verification,'unverified');
  assert.deepEqual(result.evidence,['desktop-backend-result-invalid']);
});

test('native exception after invocation remains uncertain and is not retry-safe',async()=>{
  const bridge = new ContractBridge(); bridge.throwOnDispatch = true;
  const adapter = new DesktopUiEnvironmentAdapter(new PlatformDesktopUiBackend(bridge),'desktop:contract');
  const window = await observed(adapter);
  const request = {adapterId:adapter.descriptor.id,actionId:'native-click',capability:'desktop.pointer.absolute',effect:'local-reversible' as const,idempotency:'non-idempotent' as const,target:surfaceTarget(adapter,window),payload:{kind:'click',x:10,y:20,button:'left'}};
  const result = await adapter.act(request);
  assert.equal(result.status,'unknown');
  assert.equal(result.dispatch,'unknown');
  assert.equal(result.verification,'unverified');
  assert.deepEqual(result.evidence,['desktop-backend-threw-after-invocation']);
  assert.equal(computerActionMayAutoRetry(request,result),false);
});
