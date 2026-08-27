import test from 'node:test';
import assert from 'node:assert/strict';
import { assessWindowsUiaSemanticPromotionCandidate } from '../src/computer/windowsUiaSemanticPromotionCandidate.js';
import { WindowsUiaSemanticRecipeRegistry } from '../src/computer/windowsUiaSemanticRecipeRegistry.js';
import { digestWindowsUiaSemanticRecipeManifest, type WindowsUiaSemanticRecipeManifest } from '../src/computer/windowsUiaSemanticRecipeManifest.js';
import type { WindowsUiaSemanticOfflineEvaluation } from '../src/computer/windowsUiaSemanticOfflineEvaluation.js';

function manifest(revision:number,names:readonly string[],parentDigest?:string):WindowsUiaSemanticRecipeManifest {
  return Object.freeze({schemaVersion:1,revision,...(parentDigest?{parentDigest}:{}),evidenceIds:Object.freeze([`evidence-${revision}`]),recipe:Object.freeze({id:'save-skill',locator:Object.freeze({id:'save-target',names:Object.freeze(names),controlTypes:Object.freeze(['Button']),requiredPatterns:Object.freeze(['invoke'] as const)}),action:Object.freeze({kind:'invoke' as const})})});
}
function evaluation(input:Partial<WindowsUiaSemanticOfflineEvaluation>={}):WindowsUiaSemanticOfflineEvaluation {
  return Object.freeze({status:'improved',cases:2,recoveries:1,regressions:0,stableReady:1,proposedUnresolved:0,generalization:Object.freeze({distinctApplications:0,distinctProviderFamilies:0,domains:Object.freeze([]),partitions:Object.freeze([])}),caseResults:Object.freeze([]),promotionEligible:false,authorityGranted:false,...input});
}
function registryPair(){
  const registry=new WindowsUiaSemanticRecipeRegistry();
  const base=manifest(1,['Save']);
  const baseEntry=registry.register(base);
  const proposed=manifest(2,['Save','Store'],baseEntry.digest);
  const proposedEntry=registry.register(proposed);
  return {registry,baseEntry,proposedEntry};
}

test('zero-regression exact child becomes reviewable but never approved or authoritative',()=>{
  const {registry,baseEntry,proposedEntry}=registryPair();
  const result=assessWindowsUiaSemanticPromotionCandidate(registry,{recipeId:'save-skill',baseDigest:baseEntry.digest,proposedDigest:proposedEntry.digest,evaluation:evaluation(),evidenceIds:['offline-replay-001']});
  assert.equal(result.status,'reviewable');
  assert.deepEqual(result.reasons,[]);
  assert.equal(result.promotionApproved,false);
  assert.equal(result.authorityGranted,false);
  assert.equal('dispatch' in result,false);
  assert.equal('active' in result,false);
});

test('offline regression blocks human-review candidate',()=>{
  const {registry,baseEntry,proposedEntry}=registryPair();
  const result=assessWindowsUiaSemanticPromotionCandidate(registry,{recipeId:'save-skill',baseDigest:baseEntry.digest,proposedDigest:proposedEntry.digest,evaluation:evaluation({status:'regressed',recoveries:0,regressions:1}),evidenceIds:['offline-replay-regression']});
  assert.equal(result.status,'blocked');
  assert.ok(result.reasons.includes('offline-replay-regression'));
  assert.equal(result.promotionApproved,false);
});

test('unregistered proposed digest cannot become reviewable',()=>{
  const registry=new WindowsUiaSemanticRecipeRegistry();
  const base=manifest(1,['Save']);
  const baseEntry=registry.register(base);
  const missing=`sha256:${'0'.repeat(64)}`;
  const result=assessWindowsUiaSemanticPromotionCandidate(registry,{recipeId:'save-skill',baseDigest:baseEntry.digest,proposedDigest:missing,evaluation:evaluation(),evidenceIds:['offline-replay-missing']});
  assert.equal(result.status,'blocked');
  assert.ok(result.reasons.includes('proposed-manifest-not-registered'));
});

test('candidate requires bounded unique replay/review evidence ids',()=>{
  const {registry,baseEntry,proposedEntry}=registryPair();
  assert.throws(()=>assessWindowsUiaSemanticPromotionCandidate(registry,{recipeId:'save-skill',baseDigest:baseEntry.digest,proposedDigest:proposedEntry.digest,evaluation:evaluation(),evidenceIds:[]}),/promotion-candidate-invalid/);
  assert.throws(()=>assessWindowsUiaSemanticPromotionCandidate(registry,{recipeId:'save-skill',baseDigest:baseEntry.digest,proposedDigest:proposedEntry.digest,evaluation:evaluation(),evidenceIds:['same','same']}),/promotion-candidate-invalid/);
});

test('candidate rejects forged evaluation authority flags',()=>{
  const {registry,baseEntry,proposedEntry}=registryPair();
  const forged={...evaluation(),authorityGranted:true} as unknown as WindowsUiaSemanticOfflineEvaluation;
  assert.throws(()=>assessWindowsUiaSemanticPromotionCandidate(registry,{recipeId:'save-skill',baseDigest:baseEntry.digest,proposedDigest:proposedEntry.digest,evaluation:forged,evidenceIds:['offline-replay-001']}),/promotion-evaluation-invalid/);
});
