import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NativeJsonDesktopPlatformBridge,
  type DesktopBridgeExecutor,
} from '../src/computer/nativeDesktopJsonBridge.js';

class RecordingExecutor implements DesktopBridgeExecutor {
  calls:Array<{operation:string;payload:unknown;limits:{maxResponseBytes:number;timeoutMs:number}}> = [];
  response:unknown = {};
  error?:Error;
  async invoke(operation:string,payload:unknown,limits:{maxResponseBytes:number;timeoutMs:number}):Promise<unknown> {
    this.calls.push({operation,payload,limits});
    if (this.error) throw this.error;
    return this.response;
  }
}

const window = {
  nativeId:'native-window-1',
  instanceToken:'window-instance-1',
  title:'Editor',
  foreground:true,
  focused:true,
};

test('native bridge passes hard window acquisition limits to helper and validates returned bound',async()=>{
  const executor = new RecordingExecutor();
  executor.response = {windows:[window],truncated:false};
  const bridge = new NativeJsonDesktopPlatformBridge('test','linux-atspi',executor,{
    maxResponseBytes:8_192,
    timeoutMs:750,
  });
  const result = await bridge.enumerateWindows({maxItems:1,maxTextBytes:128,maxDepth:2});
  assert.equal(result.windows.length,1);
  assert.deepEqual(executor.calls[0],{
    operation:'enumerate-windows',
    payload:{limits:{maxItems:1,maxTextBytes:128,maxDepth:2}},
    limits:{maxResponseBytes:8_192,timeoutMs:750},
  });
  executor.response = {windows:[window,{...window,nativeId:'native-window-2',instanceToken:'window-instance-2'}],truncated:true};
  await assert.rejects(()=>bridge.enumerateWindows({maxItems:1,maxTextBytes:128,maxDepth:2}),/window response malformed/);
});

test('native accessibility response is rebuilt and rejected when helper exceeds tree limits',async()=>{
  const executor = new RecordingExecutor();
  const bridge = new NativeJsonDesktopPlatformBridge('test','windows-uia',executor);
  executor.response = {
    status:'available',
    windowInstanceToken:'window-instance-1',
    root:{nativeId:'root',instanceToken:'root-instance',role:'window',children:[
      {nativeId:'child-1',instanceToken:'child-instance-1',role:'button',name:'Save'},
    ]},
  };
  const result = await bridge.accessibility(window,{maxItems:2,maxTextBytes:256,maxDepth:1});
  assert.equal(result.status,'available');
  if (result.status !== 'available') throw new Error('expected accessibility result');
  assert.ok(Object.isFrozen(result));
  assert.ok(Object.isFrozen(result.root!));
  assert.equal(result.root!.children?.[0]?.name,'Save');

  executor.response = {
    status:'available',
    windowInstanceToken:'window-instance-1',
    root:{nativeId:'root',instanceToken:'root-instance',children:[
      {nativeId:'child-1',instanceToken:'child-instance-1'},
      {nativeId:'child-2',instanceToken:'child-instance-2'},
    ]},
  };
  await assert.rejects(()=>bridge.accessibility(window,{maxItems:2,maxTextBytes:256,maxDepth:1}),/exceeded acquisition limits/);
});

test('native visual response cannot exceed pixel or byte acquisition limits',async()=>{
  const executor = new RecordingExecutor();
  const bridge = new NativeJsonDesktopPlatformBridge('test','macos-accessibility',executor);
  executor.response = {
    status:'available',
    windowInstanceToken:'window-instance-1',
    width:20,
    height:20,
    artifact:{token:'capture-1',mediaType:'image/png',byteLength:512},
  };
  await assert.rejects(()=>bridge.visual(window,{maxPixels:300,maxBytes:1_024}),/visual dimensions exceeded/);

  executor.response = {
    status:'available',
    windowInstanceToken:'window-instance-1',
    width:10,
    height:10,
    artifact:{token:'capture-1',mediaType:'image/png',byteLength:2_048},
  };
  await assert.rejects(()=>bridge.visual(window,{maxPixels:300,maxBytes:1_024}),/visual artifact exceeded/);
});

test('native dispatch rejects malformed result rather than manufacturing transport success',async()=>{
  const executor = new RecordingExecutor();
  const bridge = new NativeJsonDesktopPlatformBridge('test','linux-atspi',executor);
  executor.response = {status:'completed',dispatched:'yes',verified:true};
  await assert.rejects(()=>bridge.dispatch({
    kind:'keyboard',
    target:{nativeWindowId:'native-window-1',expectedWindowInstanceToken:'window-instance-1'},
    input:{kind:'key-down',key:'Enter'},
  },'local-reversible'),/dispatch result malformed/);
});

test('native helper failure propagates because dispatch may already have occurred',async()=>{
  const executor = new RecordingExecutor();
  executor.error = new Error('helper disconnected');
  const bridge = new NativeJsonDesktopPlatformBridge('test','linux-atspi',executor);
  await assert.rejects(()=>bridge.dispatch({
    kind:'pointer-absolute',
    target:{nativeWindowId:'native-window-1',expectedWindowInstanceToken:'window-instance-1'},
    input:{kind:'click',x:4,y:5,button:'left'},
  },'local-reversible'),/helper disconnected/);
});
