import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsNativeHostProtocolClient } from '../src/computer/windowsNativeHostProtocol.js';
import { WindowsNativeHostSystemObserver } from '../src/computer/windowsNativeHostSystem.js';

function protocol(handler:(operation:string)=>unknown){
  let sequence=0;
  return new WindowsNativeHostProtocolClient({
    maxMessageBytes:256_000,
    exchange:async request=>({protocol:1,id:request.id,status:'ok',body:handler(request.operation)}),
    close:async()=>undefined,
  },{next:()=>`system-${++sequence}`});
}
const window={
  hwnd:'0x123',desktopSessionId:'session:1',process:{processId:123,startIdentity:'2026-08-27T00:00:00.0000000Z'},generation:2,
};

test('native window observer preserves exact generation-bearing identities and accounting',async()=>{
  const observer=new WindowsNativeHostSystemObserver(protocol(()=>({
    windows:[
      {window,title:'Notepad',foreground:true,bounds:{x:10,y:20,width:800,height:600}},
      {window:{...window,hwnd:'0x124',generation:0},title:'Calculator',foreground:false,bounds:{x:900,y:20,width:500,height:700}},
    ],
    truncated:false,itemCount:2,textBytes:17,
  })));
  const result=await observer.observeWindows({maxItems:10,maxTextBytes:100});
  assert.equal(result.windows[0]?.window.generation,2);
  assert.equal(result.windows[0]?.foreground,true);
  assert.equal(result.itemCount,2);
  assert.equal(result.textBytes,17);
});

test('native window observer rejects provider accounting and multiple foreground claims',async()=>{
  const badCount=new WindowsNativeHostSystemObserver(protocol(()=>({
    windows:[{window,title:'A',foreground:true,bounds:{x:0,y:0,width:1,height:1}}],
    truncated:false,itemCount:2,textBytes:1,
  })));
  await assert.rejects(()=>badCount.observeWindows({maxItems:10,maxTextBytes:100}),/response-invalid/);

  const badForeground=new WindowsNativeHostSystemObserver(protocol(()=>({
    windows:[
      {window,title:'A',foreground:true,bounds:{x:0,y:0,width:1,height:1}},
      {window:{...window,hwnd:'0x124'},title:'B',foreground:true,bounds:{x:1,y:1,width:1,height:1}},
    ],
    truncated:false,itemCount:2,textBytes:2,
  })));
  await assert.rejects(()=>badForeground.observeWindows({maxItems:10,maxTextBytes:100}),/response-invalid/);
});

test('native window observer rejects accessors without invoking them',async()=>{
  let getterCalls=0;
  const malicious=Object.defineProperty({},'windows',{enumerable:true,get(){getterCalls+=1;return [];}});
  const observer=new WindowsNativeHostSystemObserver(protocol(()=>malicious));
  await assert.rejects(()=>observer.observeWindows({maxItems:10,maxTextBytes:100}),/response-invalid/);
  assert.equal(getterCalls,0);
});

test('native virtual desktop geometry is bounded before pointer normalization',async()=>{
  const observer=new WindowsNativeHostSystemObserver(protocol(operation=>operation==='system.virtual-desktop'
    ? {left:-1920,top:0,width:3840,height:1080}
    : {windows:[],truncated:false,itemCount:0,textBytes:0}));
  assert.deepEqual(await observer.observeVirtualDesktop(),{left:-1920,top:0,width:3840,height:1080});
});

test('invalid virtual desktop dimensions fail before pointer planning',async()=>{
  const observer=new WindowsNativeHostSystemObserver(protocol(()=>({left:0,top:0,width:0,height:1080})));
  await assert.rejects(()=>observer.observeVirtualDesktop(),/virtual-desktop-response-invalid/);
});
