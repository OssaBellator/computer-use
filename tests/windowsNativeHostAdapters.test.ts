import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsNativeHostProtocolClient } from '../src/computer/windowsNativeHostProtocol.js';
import {
  WindowsNativeHostCaptureBridge,
  WindowsNativeHostIntegrityReader,
  WindowsNativeHostSendInputBridge,
  WindowsNativeHostUiaClient,
} from '../src/computer/windowsNativeHostAdapters.js';
import type { WindowsUiaWindowRef, WindowsUiaControlRef } from '../src/computer/windowsUiaContract.js';

const windowRef:WindowsUiaWindowRef=Object.freeze({
  hwnd:'0xabc',desktopSessionId:'interactive:1',process:Object.freeze({processId:321,startIdentity:'p321'}),generation:2,
});
const ref:WindowsUiaControlRef=Object.freeze({window:windowRef,runtimeId:Object.freeze([1,2,3]),controlType:'Button',generation:4});
const context=Object.freeze({apartment:'mta' as const,threadToken:'uia-mta'});
const inputAuthority=Object.freeze({targetWindow:windowRef,humanInputSequence:7});

function protocol(handler:(operation:string,body:unknown)=>unknown) {
  let sequence=0;
  return new WindowsNativeHostProtocolClient({
    maxMessageBytes:256_000,
    exchange:async(request)=>({protocol:1,id:request.id,status:'ok',body:handler(request.operation,request.body)}),
    close:async()=>undefined,
  },{next:()=>`req-${++sequence}`});
}

test('UIA native host adapter validates handles, snapshots and dispatch results', async () => {
  const client=new WindowsNativeHostUiaClient(protocol((operation)=>{
    if(operation==='uia.resolve-window')return {status:'current',root:{token:'root-1'}};
    if(operation==='uia.build-cache')return {
      window:windowRef,
      root:{ref:{window:windowRef,runtimeId:[9],controlType:'Window',generation:1},patterns:['window']},
      itemCount:1,textBytes:0,truncated:false,invalidationEpoch:0,capturedAtMs:1,
    };
    if(operation==='uia.resolve-control')return {status:'candidate',element:{token:'element-1'}};
    if(operation==='uia.compare-elements')return {same:true};
    if(operation==='uia.snapshot-control')return {status:'current',control:{ref,enabled:true,patterns:['invoke']}};
    if(operation==='uia.perform-pattern')return {status:'completed',dispatched:true,verified:false,evidence:['native-pattern']};
    return {};
  }));
  const root=await client.resolveWindow(context,windowRef);
  assert.equal(root.status,'current');
  const cache=await client.buildCache(context,{token:'root-1'},{treeScope:'element-and-children',controlViewOnly:true,elementMode:'full',properties:[],patterns:[],maxItems:1,maxDepth:1,maxTextBytes:1},0);
  assert.equal(cache.window.hwnd,'0xabc');
  assert.equal(cache.root?.ref.controlType,'Window');
  const candidate=await client.resolveControl(context,ref);
  assert.equal(candidate.status,'candidate');
  assert.equal(await client.compareElements(context,{token:'element-1'},{token:'element-1'}),true);
  const snapshot=await client.snapshotControl(context,{token:'element-1'},ref);
  assert.equal(snapshot.status,'current');
  const result=await client.performPattern(context,{token:'element-1'},ref,{kind:'invoke'},'local-reversible');
  assert.deepEqual(result,{status:'completed',dispatched:true,verified:false,evidence:['native-pattern']});
});

test('malformed native UIA body is rejected at adapter boundary', async () => {
  const client=new WindowsNativeHostUiaClient(protocol((operation)=>operation==='uia.resolve-control'
    ? {status:'candidate',element:{token:'bad token with spaces'}}
    : {}));
  await assert.rejects(()=>client.resolveControl(context,ref),/resolve-control-invalid/);
});

test('capture adapter returns bounded frame structure for runtime revalidation', async () => {
  const client=new WindowsNativeHostCaptureBridge(protocol((operation)=>operation==='capture.next-frame'?{
    window:windowRef,captureGeneration:2,frameSequence:3,capturedAtMs:10,systemRelativeTime100ns:20,
    contentWidth:640,contentHeight:480,geometry:{left:10,top:20,width:640,height:480,dpi:144},
    artifact:{token:'capture-2-3',mediaType:'image/png',byteLength:30_000},
  }:{released:true}));
  const frame=await client.captureNextFrame(windowRef,{maxPixels:1_000_000,maxBytes:1_000_000});
  assert.equal(frame.frameSequence,3);
  assert.equal(frame.geometry.dpi,144);
  await client.releaseArtifact('capture-2-3');
});

test('capture adapter consumes one bounded artifact payload and validates exact base64 length',async()=>{
  const data=Buffer.from([1,2,3,4]).toString('base64');
  const client=new WindowsNativeHostCaptureBridge(protocol((operation)=>operation==='artifact.consume'
    ? {mediaType:'image/png',byteLength:4,dataBase64:data}
    : {}));
  const consumed=await client.consumeArtifact('capture-1',16);
  assert.equal(consumed.mediaType,'image/png');
  assert.deepEqual([...consumed.bytes],[1,2,3,4]);

  const malformed=new WindowsNativeHostCaptureBridge(protocol(()=>({mediaType:'image/png',byteLength:3,dataBase64:data})));
  await assert.rejects(()=>malformed.consumeArtifact('capture-1',16),/consume-response-invalid/);
});

test('integrity and SendInput adapters require bounded numeric native results and exact authority payload', async () => {
  let inputBody:unknown;
  const p=protocol((operation,body)=>{
    if(operation==='integrity.current')return {rid:0x2000};
    if(operation==='integrity.process')return {rid:0x1000};
    if(operation==='input.send'){inputBody=body;return {insertedEventCount:2};}
    return {};
  });
  const integrity=new WindowsNativeHostIntegrityReader(p);
  assert.equal(await integrity.currentProcessIntegrityRid(),0x2000);
  assert.equal(await integrity.processIntegrityRid(windowRef.process),0x1000);
  const input=new WindowsNativeHostSendInputBridge(p);
  assert.deepEqual(await input.sendInput([
    {kind:'keyboard-unicode',codeUnit:65,keyUp:false},
    {kind:'keyboard-unicode',codeUnit:65,keyUp:true},
  ],inputAuthority),{insertedEventCount:2});
  assert.deepEqual(inputBody,{
    events:[
      {kind:'keyboard-unicode',codeUnit:65,keyUp:false},
      {kind:'keyboard-unicode',codeUnit:65,keyUp:true},
    ],
    targetWindow:windowRef,
    expectedHumanInputSequence:7,
  });
});

test('native SendInput adapter preserves definite pre-dispatch failure without crossing into UNKNOWN',async()=>{
  const input=new WindowsNativeHostSendInputBridge(protocol(()=>({
    insertedEventCount:0,preDispatchFailure:'windows-input-target-not-foreground',
  })));
  assert.deepEqual(await input.sendInput([{kind:'mouse-relative-move',dx:0,dy:0}],inputAuthority),{
    insertedEventCount:0,preDispatchFailure:'windows-input-target-not-foreground',
  });
});

test('native adapter rejects impossible inserted count and malformed pre-dispatch result before gate sees it', async () => {
  const impossible=new WindowsNativeHostSendInputBridge(protocol(()=>({insertedEventCount:5000})));
  await assert.rejects(()=>impossible.sendInput([{kind:'mouse-relative-move',dx:1,dy:1}],inputAuthority),/input-response-invalid/);

  const contradictory=new WindowsNativeHostSendInputBridge(protocol(()=>({insertedEventCount:1,preDispatchFailure:'windows-input-target-not-foreground'})));
  await assert.rejects(()=>contradictory.sendInput([{kind:'mouse-relative-move',dx:1,dy:1}],inputAuthority),/input-response-invalid/);
});
