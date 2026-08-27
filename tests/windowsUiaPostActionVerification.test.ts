import test from 'node:test';
import assert from 'node:assert/strict';
import { createWindowsUiaActionVerification } from '../src/computer/windowsUiaPostActionVerification.js';
import type { WindowsUiaControlRef, WindowsUiaProvider, WindowsUiaWindowRef } from '../src/computer/windowsUiaContract.js';

const window:WindowsUiaWindowRef=Object.freeze({
  hwnd:'0x710',desktopSessionId:'session:1',process:Object.freeze({processId:710,startIdentity:'p710'}),generation:2,
});
const ref:WindowsUiaControlRef=Object.freeze({window,runtimeId:Object.freeze([7,1,0]),controlType:'Edit',generation:4});

function provider(revalidate:WindowsUiaProvider['revalidateControl']):Pick<WindowsUiaProvider,'revalidateControl'>{return {revalidateControl:revalidate};}

test('set-value verification matches only exact fresh semantic value',async()=>{
  const verification=createWindowsUiaActionVerification(provider(async captured=>({
    status:'current',control:{ref:captured,value:'expected',enabled:true,patterns:['value']},
  })),ref,{kind:'set-value',value:'expected'},()=>500)!;
  const observation=await verification.provider.observe();
  assert.equal(observation.sequence,1);
  assert.equal(observation.capturedAtMs,500);
  assert.equal(verification.predicate(observation),'match');
});

test('wrong current value remains inconclusive instead of becoming premature mismatch',async()=>{
  const verification=createWindowsUiaActionVerification(provider(async captured=>({
    status:'current',control:{ref:captured,value:'still-old',patterns:['value']},
  })),ref,{kind:'set-value',value:'expected'},()=>500)!;
  assert.equal(verification.predicate(await verification.provider.observe()),'inconclusive');
});

test('window close verifies exact missing identity but not stale/replaced identity',async()=>{
  let status:'missing'|'stale'='missing';
  const verification=createWindowsUiaActionVerification(provider(async()=>({status})),ref,{kind:'window',operation:'close'},()=>500)!;
  assert.equal(verification.predicate(await verification.provider.observe()),'match');
  status='stale';
  assert.equal(verification.predicate(await verification.provider.observe()),'inconclusive');
});

test('patterns without normalized authoritative post-state do not get generic verification',()=>{
  const p=provider(async()=>({status:'missing'}));
  assert.equal(createWindowsUiaActionVerification(p,ref,{kind:'invoke'}),undefined);
  assert.equal(createWindowsUiaActionVerification(p,ref,{kind:'toggle'}),undefined);
  assert.equal(createWindowsUiaActionVerification(p,ref,{kind:'select'}),undefined);
  assert.equal(createWindowsUiaActionVerification(p,ref,{kind:'expand-collapse',state:'expanded'}),undefined);
  assert.equal(createWindowsUiaActionVerification(p,ref,{kind:'scroll',horizontal:'no-amount',vertical:'small-increment'}),undefined);
  assert.equal(createWindowsUiaActionVerification(p,ref,{kind:'set-range-value',value:5}),undefined);
  assert.equal(createWindowsUiaActionVerification(p,ref,{kind:'window',operation:'maximize'}),undefined);
});

test('malformed provider revalidation is rejected at verification observer boundary',async()=>{
  const verification=createWindowsUiaActionVerification(provider(async()=>({status:'current'} as never)),ref,{kind:'set-value',value:'x'},()=>500)!;
  await assert.rejects(()=>verification.provider.observe(),/observation-invalid/);
});
