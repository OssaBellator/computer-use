import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWindowsVisualPostActionEvidence } from '../src/computer/windowsVisualPostActionEvidence.js';

const dispatched=Object.freeze({status:'completed' as const,dispatch:'dispatched-once' as const,verification:'unverified' as const});

test('visual agreement is weak evidence and cannot manufacture semantic verification',async()=>{
  const result=await assessWindowsVisualPostActionEvidence(
    dispatched,
    {observe:async()=>({frameSequence:2,capturedAtMs:200,value:true})},
    ()=> 'match',
    100,
  );
  assert.equal(result.status,'completed');
  assert.equal(result.dispatch,'dispatched-once');
  assert.equal(result.verification,'unverified');
  assert.ok(result.evidence?.includes('windows-visual-post-action-consistent'));
});

test('visual disagreement cannot override authoritative semantic verification',async()=>{
  const verified=Object.freeze({...dispatched,verification:'verified' as const,evidence:Object.freeze(['windows-post-action-verified'])});
  const result=await assessWindowsVisualPostActionEvidence(
    verified,
    {observe:async()=>({frameSequence:3,capturedAtMs:200,value:false})},
    ()=> 'mismatch',
    100,
  );
  assert.equal(result.verification,'verified');
  assert.ok(result.evidence?.includes('windows-post-action-verified'));
  assert.ok(result.evidence?.includes('windows-visual-post-action-conflict'));
});

test('visual evidence preserves sticky UNKNOWN and rejects stale samples as proof',async()=>{
  const unknown=Object.freeze({status:'unknown' as const,dispatch:'unknown' as const,verification:'unverified' as const});
  const result=await assessWindowsVisualPostActionEvidence(
    unknown,
    {observe:async()=>({frameSequence:4,capturedAtMs:50,value:true})},
    ()=> 'match',
    100,
  );
  assert.equal(result.status,'unknown');
  assert.equal(result.dispatch,'unknown');
  assert.equal(result.verification,'unverified');
  assert.ok(result.evidence?.includes('windows-visual-post-action-stale'));
});
