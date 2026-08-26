import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveObservationTrust, mayContributeInstructionAuthority, observationTrust } from '../src/computer/observationTrust.js';
import { DesktopInteractionLeaseManager } from '../src/computer/desktopInteractionLease.js';
import { resolveGrounding, type GroundingCandidate } from '../src/computer/groundingResolver.js';

const surface = { adapterId:'desktop:test', environment:'desktop-ui' as const, surfaceId:'win-1', generation:7 };

test('external content cannot acquire instruction authority through derivation', () => {
  const web = observationTrust('external-untrusted-content',['web-page']);
  const summary = deriveObservationTrust([web],['model-summary']);
  assert.equal(web.instructionAuthority,false);
  assert.equal(summary.instructionAuthority,false);
  assert.equal(summary.containsExternalUntrustedContent,true);
  assert.equal(mayContributeInstructionAuthority(summary),false);
  assert.deepEqual(summary.provenance,['web-page','model-summary']);
});

test('user and host sources are authoritative only at their original boundary', () => {
  const user = observationTrust('user-authored',['task']);
  const host = observationTrust('host-policy',['policy']);
  assert.equal(mayContributeInstructionAuthority(user),true);
  assert.equal(mayContributeInstructionAuthority(host),true);
  const derived = deriveObservationTrust([user,host],['planner-view']);
  assert.equal(mayContributeInstructionAuthority(derived),false);
});

test('interactive host lease detects human interference and exact target drift', async () => {
  let sequence = 11;
  let now = 1_000;
  const manager = new DesktopInteractionLeaseManager({ snapshot: async () => ({sequence}) }, () => now);
  const lease = await manager.acquire({leaseId:'lease-1',mode:'interactive-host',targetDesktop:'desktop-1',targetSurface:surface,durationMs:1_000});
  assert.deepEqual(await manager.validate(lease,{targetDesktop:'desktop-1',targetSurface:surface}),{status:'valid'});
  assert.deepEqual(await manager.validate(lease,{targetDesktop:'desktop-1',targetSurface:{...surface,generation:8}}),{status:'target-mismatch'});
  sequence += 1;
  assert.deepEqual(await manager.validate(lease,{targetDesktop:'desktop-1',targetSurface:surface}),{status:'human-interference'});
  sequence = 11;
  now = 2_000;
  assert.deepEqual(await manager.validate(lease,{targetDesktop:'desktop-1',targetSurface:surface}),{status:'expired'});
});

test('background semantic lease does not depend on host input sequence', async () => {
  let sequence = 1;
  const manager = new DesktopInteractionLeaseManager({ snapshot: async () => ({sequence}) }, () => 100);
  const lease = await manager.acquire({leaseId:'lease-bg',mode:'background-semantic',targetDesktop:'desktop-1',durationMs:1_000});
  sequence = 999;
  assert.deepEqual(await manager.validate(lease,{targetDesktop:'desktop-1'}),{status:'valid'});
});

test('grounding resolver prefers semantic authority over higher-confidence pixels', () => {
  const candidates: GroundingCandidate[] = [
    {id:'visual-save',kind:'visual-grounded',confidence:0.99,supported:true,stale:false,frame:{surface,frameSequence:44,capturedAtMs:1}},
    {id:'uia-save',kind:'semantic-ui',confidence:0.72,supported:true,stale:false,target:{adapterId:'desktop:test',environment:'desktop-ui',kind:'ui-control',entityId:'save',surfaceId:'win-1',generation:7}},
  ];
  const result = resolveGrounding(candidates);
  assert.equal(result.selected?.id,'uia-save');
});

test('visual and coordinate candidates fail closed unless frame and generation bound', () => {
  const noFrame: GroundingCandidate = {id:'pixel-1',kind:'raw-coordinate',confidence:1,supported:true,stale:false};
  const noGeneration: GroundingCandidate = {id:'visual-1',kind:'visual-grounded',confidence:1,supported:true,stale:false,frame:{surface:{...surface,generation:undefined},frameSequence:1,capturedAtMs:1}};
  const result = resolveGrounding([noFrame,noGeneration]);
  assert.equal(result.selected,undefined);
  assert.deepEqual(result.rejected.map((entry)=>entry.reason),['visual-candidate-not-frame-bound','visual-candidate-not-generation-bound']);
});
