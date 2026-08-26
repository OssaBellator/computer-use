import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsNativeHostHumanInputObserver } from '../src/computer/windowsNativeHostHumanInput.js';
import { WindowsNativeHostProtocolClient } from '../src/computer/windowsNativeHostProtocol.js';

function protocol(body:unknown){
  let sequence=0;
  return new WindowsNativeHostProtocolClient({
    maxMessageBytes:256_000,
    exchange:async request=>({protocol:1,id:request.id,status:'ok',body}),
    close:async()=>undefined,
  },{next:()=>`human-${++sequence}`});
}

test('native human input observer returns bounded monotonic-compatible sequence',async()=>{
  const observer=new WindowsNativeHostHumanInputObserver(protocol({sequence:42}));
  assert.deepEqual(await observer.snapshot(),{sequence:42});
});

test('native human input observer rejects malformed or accessor-bearing responses',async()=>{
  const negative=new WindowsNativeHostHumanInputObserver(protocol({sequence:-1}));
  await assert.rejects(()=>negative.snapshot(),/human-input-response-invalid/);

  let getterCalls=0;
  const malicious=Object.defineProperty({},'sequence',{enumerable:true,get(){getterCalls+=1;return 7;}});
  const accessor=new WindowsNativeHostHumanInputObserver(protocol(malicious));
  await assert.rejects(()=>accessor.snapshot(),/human-input-response-invalid/);
  assert.equal(getterCalls,0);
});
