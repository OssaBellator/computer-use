import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsNativeHostProtocolClient } from '../src/computer/windowsNativeHostProtocol.js';
import { WindowsNativeHostWindowAuthority } from '../src/computer/windowsNativeHostWindowAuthority.js';
import type { WindowsUiaWindowRef } from '../src/computer/windowsUiaContract.js';

const owner:WindowsUiaWindowRef=Object.freeze({
  hwnd:'0x100',desktopSessionId:'session:1',process:Object.freeze({processId:100,startIdentity:'p100'}),generation:2,
});
const modal:WindowsUiaWindowRef=Object.freeze({
  hwnd:'0x101',desktopSessionId:'session:1',process:Object.freeze({processId:100,startIdentity:'p100'}),generation:0,
});

function protocol(body:unknown){
  let sequence=0;
  return new WindowsNativeHostProtocolClient({
    maxMessageBytes:256_000,
    exchange:async request=>({protocol:1,id:request.id,status:'ok',body}),
    close:async()=>undefined,
  },{next:()=>`window-authority-${++sequence}`});
}

test('native window authority routes blocked owner to one exact observed modal',async()=>{
  const authority=new WindowsNativeHostWindowAuthority(protocol({
    states:[
      {window:owner,isModal:false,isTopmost:false,interactionState:'blocked-by-modal-window'},
      {window:modal,isModal:true,isTopmost:true,interactionState:'ready-for-user-interaction',owner},
    ],
    itemCount:2,
  }));
  const result=await authority.decide(owner,[owner,modal]);
  assert.equal(result.allowed,true);
  if(result.allowed)assert.equal(result.target.hwnd,modal.hwnd);
});

test('native window authority rejects a state row for a window outside the requested batch',async()=>{
  const other:WindowsUiaWindowRef=Object.freeze({...modal,hwnd:'0x999'});
  const authority=new WindowsNativeHostWindowAuthority(protocol({
    states:[{window:other,isModal:false,isTopmost:false,interactionState:'running'}],
    itemCount:1,
  }));
  await assert.rejects(()=>authority.observe([owner]),/response-invalid/);
});

test('native window authority rejects duplicate rows and incorrect accounting',async()=>{
  const duplicate=new WindowsNativeHostWindowAuthority(protocol({
    states:[
      {window:owner,isModal:false,isTopmost:false,interactionState:'running'},
      {window:owner,isModal:false,isTopmost:false,interactionState:'running'},
    ],
    itemCount:2,
  }));
  await assert.rejects(()=>duplicate.observe([owner,modal]),/response-invalid/);

  const wrongCount=new WindowsNativeHostWindowAuthority(protocol({
    states:[{window:owner,isModal:false,isTopmost:false,interactionState:'running'}],
    itemCount:2,
  }));
  await assert.rejects(()=>wrongCount.observe([owner,modal]),/response-invalid/);
});

test('native window authority rejects accessors without invoking them',async()=>{
  let getterCalls=0;
  const malicious=Object.defineProperty({},'states',{enumerable:true,get(){getterCalls+=1;return [];}});
  const authority=new WindowsNativeHostWindowAuthority(protocol(malicious));
  await assert.rejects(()=>authority.observe([owner]),/response-invalid/);
  assert.equal(getterCalls,0);
});
