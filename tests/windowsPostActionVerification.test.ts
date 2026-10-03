import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyWindowsPostAction } from '../src/computer/windowsPostActionVerification.js';
import type { ComputerActionResult } from '../src/computer/environmentAdapter.js';

const dispatched:ComputerActionResult=Object.freeze({
  status:'completed',dispatch:'dispatched-once',verification:'unverified',evidence:Object.freeze(['native-dispatch']),
});
const unknown:ComputerActionResult=Object.freeze({
  status:'unknown',dispatch:'unknown',verification:'unverified',evidence:Object.freeze(['partial-dispatch']),
});
const noDispatch:ComputerActionResult=Object.freeze({
  status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:Object.freeze(['preflight']),
});
const immediateSleep=async()=>undefined;

test('post-action verification upgrades definite dispatched-once action on fresh match',async()=>{
  const provider={observe:async()=>({sequence:11,capturedAtMs:101,value:{text:'saved'}})};
  const result=await verifyWindowsPostAction(dispatched,provider,observation=>observation.value.text==='saved'?'match':'mismatch',{
    minimumSequenceExclusive:10,notBeforeMs:100,timeoutMs:10,pollIntervalMs:0,sleep:immediateSleep,
  });
  assert.equal(result.status,'completed');
  assert.equal(result.dispatch,'dispatched-once');
  assert.equal(result.verification,'verified');
});

test('post-action verification reports definite mismatch without erasing dispatch ledger',async()=>{
  const provider={observe:async()=>({sequence:2,capturedAtMs:20,value:{checked:false}})};
  const result=await verifyWindowsPostAction(dispatched,provider,()=> 'mismatch',{timeoutMs:1,pollIntervalMs:0,sleep:immediateSleep});
  assert.equal(result.status,'failed');
  assert.equal(result.dispatch,'dispatched-once');
  assert.equal(result.verification,'mismatch');
});

test('stale pre-action samples cannot verify and a later fresh sample can',async()=>{
  const samples=[
    {sequence:5,capturedAtMs:90,value:'stale'},
    {sequence:6,capturedAtMs:110,value:'fresh'},
  ];
  let index=0;
  const provider={observe:async()=>samples[Math.min(index++,samples.length-1)]!};
  const result=await verifyWindowsPostAction(dispatched,provider,observation=>observation.value==='fresh'?'match':'mismatch',{
    minimumSequenceExclusive:5,notBeforeMs:100,timeoutMs:10,pollIntervalMs:0,sleep:immediateSleep,
  });
  assert.equal(result.verification,'verified');
});

test('matching post-state never upgrades an unknown dispatch ledger to completed',async()=>{
  const provider={observe:async()=>({sequence:1,capturedAtMs:1,value:true})};
  const result=await verifyWindowsPostAction(unknown,provider,()=> 'match',{timeoutMs:1,pollIntervalMs:0,sleep:immediateSleep});
  assert.equal(result.status,'unknown');
  assert.equal(result.dispatch,'unknown');
  assert.equal(result.verification,'verified');
});

test('observation error exhaustion remains unverified and not-dispatched actions bypass observation',async()=>{
  let calls=0;
  const provider={observe:async()=>{calls+=1;throw new Error('unavailable');}};
  const exhausted=await verifyWindowsPostAction(dispatched,provider,()=> 'match',{
    timeoutMs:10,pollIntervalMs:0,maxConsecutiveErrors:1,sleep:immediateSleep,
  });
  assert.equal(exhausted.verification,'unverified');
  assert.ok(exhausted.evidence?.includes('windows-post-action-observation-unavailable'));

  const before=calls;
  const bypass=await verifyWindowsPostAction(noDispatch,provider,()=> 'match');
  assert.equal(bypass,noDispatch);
  assert.equal(calls,before);
});
