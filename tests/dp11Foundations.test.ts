import test from 'node:test';
import assert from 'node:assert/strict';
import { deriveObservationTrust, mayContributeInstructionAuthority, observationTrust } from '../src/computer/observationTrust.js';
import { DesktopInteractionLeaseManager } from '../src/computer/desktopInteractionLease.js';
import { resolveGrounding, routeGroundingEmbodiment, type GroundingCandidate } from '../src/computer/groundingResolver.js';
import { windowsUiaSemanticGroundingCandidate } from '../src/computer/windowsUiaEmbodimentRouting.js';

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

test('bulk lease revocation invalidates every retained authority immediately',async()=>{
  const manager=new DesktopInteractionLeaseManager({snapshot:async()=>({sequence:1})},()=>100);
  const first=await manager.acquire({leaseId:'lease-a',mode:'interactive-host',targetDesktop:'desktop-1',targetSurface:surface,durationMs:1_000});
  const second=await manager.acquire({leaseId:'lease-b',mode:'background-semantic',targetDesktop:'desktop-1',durationMs:1_000});
  assert.equal(manager.releaseAll(),2);
  assert.equal(manager.releaseAll(),0);
  assert.deepEqual(await manager.validate(first,{targetDesktop:'desktop-1',targetSurface:surface}),{status:'released'});
  assert.deepEqual(await manager.validate(second,{targetDesktop:'desktop-1'}),{status:'released'});
});

test('grounding resolver prefers semantic authority over higher-confidence pixels', () => {
  const candidates: GroundingCandidate[] = [
    {id:'visual-save',kind:'visual-grounded',confidence:0.99,supported:true,stale:false,frame:{surface,frameSequence:44,capturedAtMs:1}},
    {id:'uia-save',kind:'semantic-ui',confidence:0.72,supported:true,stale:false,target:{adapterId:'desktop:test',environment:'desktop-ui',kind:'ui-control',entityId:'save',surfaceId:'win-1',generation:7}},
  ];
  const result = resolveGrounding(candidates);
  assert.equal(result.selected?.id,'uia-save');
});

test('authoritative cross-channel target conflict blocks selection instead of flattening disagreement',()=>{
  const uiaTarget={adapterId:'desktop:test',environment:'desktop-ui' as const,kind:'ui-control' as const,entityId:'save',surfaceId:'win-1',generation:7};
  const apiTarget={...uiaTarget,entityId:'document-persisted'};
  const result=resolveGrounding([
    {id:'uia-save',kind:'semantic-ui',confidence:0.99,supported:true,stale:false,target:uiaTarget},
    {id:'app-state',kind:'native-api',confidence:0.80,supported:true,stale:false,target:apiTarget},
  ]);
  assert.equal(result.selected,undefined);
  assert.deepEqual(result.conflicts,[{candidateIds:['app-state','uia-save'],reason:'authoritative-target-conflict'}]);
});

test('visual candidates cannot manufacture semantic identity or veto current semantic authority',()=>{
  const semanticTarget={adapterId:'desktop:test',environment:'desktop-ui' as const,kind:'ui-control' as const,entityId:'save',surfaceId:'win-1',generation:7};
  const visualTarget={...semanticTarget,entityId:'export'};
  const result=resolveGrounding([
    {id:'uia-save',kind:'semantic-ui',confidence:0.72,supported:true,stale:false,target:semanticTarget},
    {id:'visual-export',kind:'visual-grounded',confidence:0.999,supported:true,stale:false,target:visualTarget,frame:{surface,frameSequence:45,capturedAtMs:2}},
  ]);
  assert.equal(result.selected?.id,'uia-save');
  assert.deepEqual(result.conflicts,[]);
  assert.deepEqual(result.rejected,[{id:'visual-export',reason:'visual-candidate-semantic-target-forbidden'}]);
});

test('embodiment router exposes bounded selection reason and available fallbacks',()=>{
  const semanticTarget={adapterId:'desktop:test',environment:'desktop-ui' as const,kind:'ui-control' as const,entityId:'save',surfaceId:'win-1',generation:7};
  const decision=routeGroundingEmbodiment([
    {id:'uia-save',kind:'semantic-ui',confidence:0.8,supported:true,stale:false,target:semanticTarget},
    {id:'visual-save',kind:'visual-grounded',confidence:0.99,supported:true,stale:false,frame:{surface,frameSequence:50,capturedAtMs:5}},
    {id:'keyboard-save',kind:'keyboard-semantic',confidence:0.9,supported:true,stale:false},
  ]);
  assert.deepEqual(decision.availableEmbodiments,['semantic-ui','keyboard-semantic','visual-grounded']);
  assert.equal(decision.selectedEmbodiment,'semantic-ui');
  assert.equal(decision.selectedCandidateId,'uia-save');
  assert.equal(decision.selectionReason,'highest-authority-current-supported');
  assert.equal(decision.fallbackReason,undefined);
});

test('embodiment router exposes authoritative conflict instead of selecting through it',()=>{
  const target={adapterId:'desktop:test',environment:'desktop-ui' as const,kind:'ui-control' as const,entityId:'save',surfaceId:'win-1',generation:7};
  const decision=routeGroundingEmbodiment([
    {id:'uia-save',kind:'semantic-ui',confidence:0.9,supported:true,stale:false,target},
    {id:'native-other',kind:'native-api',confidence:0.9,supported:true,stale:false,target:{...target,entityId:'other'}},
  ]);
  assert.equal(decision.selectedEmbodiment,undefined);
  assert.equal(decision.selectionReason,'authoritative-conflict');
  assert.equal(decision.fallbackReason,'authoritative-target-conflict');
});

test('exact-target UIA support routes to fallback with provider reason instead of static platform assumption',()=>{
  const target={adapterId:'desktop:test',environment:'desktop-ui' as const,kind:'ui-control' as const,entityId:'range',surfaceId:'win-1',generation:7};
  const semantic=windowsUiaSemanticGroundingCandidate({
    id:'uia-range',confidence:0.95,target,
    support:{status:'unsupported',requiredPattern:'range-value',observedPatterns:['value','invoke','window'],evidence:['windows-uia-pattern-unsupported']},
  });
  const decision=routeGroundingEmbodiment([
    semantic,
    {id:'keyboard-range',kind:'keyboard-semantic',confidence:0.7,supported:true,stale:false},
  ]);
  assert.equal(decision.selectedEmbodiment,'keyboard-semantic');
  assert.deepEqual(decision.resolution.rejected,[{id:'uia-range',reason:'windows-uia-pattern-unsupported'}]);
});

test('stale exact-target UIA support remains stale rather than becoming a generic unsupported fallback',()=>{
  const target={adapterId:'desktop:test',environment:'desktop-ui' as const,kind:'ui-control' as const,entityId:'save',surfaceId:'win-1',generation:7};
  const semantic=windowsUiaSemanticGroundingCandidate({
    id:'uia-save',confidence:0.95,target,
    support:{status:'rejected',requiredPattern:'invoke',evidence:['windows-uia-stale','provider-stale']},
  });
  const decision=routeGroundingEmbodiment([semantic]);
  assert.equal(decision.selectedEmbodiment,undefined);
  assert.deepEqual(decision.resolution.rejected,[{id:'uia-save',reason:'stale'}]);
});

test('visual and coordinate candidates fail closed unless frame and generation bound', () => {
  const noFrame: GroundingCandidate = {id:'pixel-1',kind:'raw-coordinate',confidence:1,supported:true,stale:false};
  const noGeneration: GroundingCandidate = {id:'visual-1',kind:'visual-grounded',confidence:1,supported:true,stale:false,frame:{surface:{...surface,generation:undefined},frameSequence:1,capturedAtMs:1}};
  const result = resolveGrounding([noFrame,noGeneration]);
  assert.equal(result.selected,undefined);
  assert.deepEqual(result.rejected.map((entry)=>entry.reason),['visual-candidate-not-frame-bound','visual-candidate-not-generation-bound']);
});
