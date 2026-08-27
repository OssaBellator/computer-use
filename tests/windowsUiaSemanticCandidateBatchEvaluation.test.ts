import test from 'node:test';
import assert from 'node:assert/strict';
import type { WindowsUiaCachedObservation, WindowsUiaControlSnapshot, WindowsUiaWindowRef } from '../src/computer/windowsUiaContract.js';
import { evaluateWindowsUiaSemanticCandidateBatch } from '../src/computer/windowsUiaSemanticCandidateBatchEvaluation.js';
import { digestWindowsUiaSemanticRecipeManifest, type WindowsUiaSemanticRecipeManifest } from '../src/computer/windowsUiaSemanticRecipeManifest.js';

const windowRef:WindowsUiaWindowRef=Object.freeze({hwnd:'0x730',desktopSessionId:'interactive:1',process:Object.freeze({processId:730,startIdentity:'p730'}),generation:1});
function node(runtimeId:number[],name:string):WindowsUiaControlSnapshot{
  return Object.freeze({ref:Object.freeze({window:windowRef,runtimeId:Object.freeze(runtimeId),controlType:'Button',generation:1}),name,patterns:Object.freeze(['invoke'] as const)});
}
function observation(children:readonly WindowsUiaControlSnapshot[]):WindowsUiaCachedObservation{
  const root:WindowsUiaControlSnapshot=Object.freeze({ref:Object.freeze({window:windowRef,runtimeId:Object.freeze([1]),controlType:'Window',generation:1}),patterns:Object.freeze(['window'] as const),children:Object.freeze([...children])});
  const textBytes=children.reduce((sum,child)=>sum+Buffer.byteLength(child.name??'','utf8'),0);
  return Object.freeze({window:windowRef,root,itemCount:children.length+1,textBytes,truncated:false,invalidationEpoch:1,capturedAtMs:1});
}
function base():WindowsUiaSemanticRecipeManifest{
  return Object.freeze({
    schemaVersion:1,revision:1,evidenceIds:Object.freeze(['base']),
    recipe:Object.freeze({
      id:'save-skill',
      locator:Object.freeze({id:'save-target',names:Object.freeze(['Save']),controlTypes:Object.freeze(['Button']),requiredPatterns:Object.freeze(['invoke'] as const)}),
      action:Object.freeze({kind:'invoke' as const}),
    }),
  });
}
function child(parent:WindowsUiaSemanticRecipeManifest,names:readonly string[],evidence:string):WindowsUiaSemanticRecipeManifest{
  return Object.freeze({
    schemaVersion:1,revision:2,parentDigest:digestWindowsUiaSemanticRecipeManifest(parent),evidenceIds:Object.freeze(['base',evidence]),
    recipe:Object.freeze({
      id:'save-skill',
      locator:Object.freeze({id:'save-target',names:Object.freeze(names),controlTypes:Object.freeze(['Button']),requiredPatterns:Object.freeze(['invoke'] as const)}),
      action:Object.freeze({kind:'invoke' as const}),
    }),
  });
}
const cases=Object.freeze([
  Object.freeze({caseId:'save-case',partition:'development' as const,applicationId:'app-a',providerFamily:'provider-a',observation:observation([node([2],'Save')])}),
  Object.freeze({caseId:'store-holdout',partition:'holdout' as const,applicationId:'app-b',providerFamily:'provider-b',observation:observation([node([3],'Store')])}),
]);

test('candidate batch compares multiple child revisions on one immutable corpus without selecting a winner',()=>{
  const parent=base();
  const store=child(parent,['Save','Store'],'store');
  const commit=child(parent,['Save','Commit'],'commit');
  const result=evaluateWindowsUiaSemanticCandidateBatch(parent,[store,commit],cases);
  assert.equal(result.candidateCount,2);
  assert.equal(result.baseDigest,digestWindowsUiaSemanticRecipeManifest(parent));
  assert.equal(result.candidates.every((entry)=>entry.evaluation.corpusDigest===result.corpusDigest),true);
  assert.equal(result.comparisonOnly,true);
  assert.equal(result.selectionMade,false);
  assert.equal(result.promotionApproved,false);
  assert.equal(result.authorityGranted,false);
  assert.equal('winner' in result,false);
  assert.equal('active' in result,false);
  assert.equal('dispatch' in result,false);
});

test('candidate batch output is deterministic under candidate reordering',()=>{
  const parent=base();
  const a=child(parent,['Save','Store'],'a');
  const b=child(parent,['Save','Commit'],'b');
  const first=evaluateWindowsUiaSemanticCandidateBatch(parent,[a,b],cases);
  const second=evaluateWindowsUiaSemanticCandidateBatch(parent,[b,a],cases);
  assert.deepEqual(first.candidates.map((entry)=>entry.proposedDigest),second.candidates.map((entry)=>entry.proposedDigest));
  assert.equal(first.corpusDigest,second.corpusDigest);
});

test('candidate batch rejects duplicate immutable candidates',()=>{
  const parent=base();
  const proposed=child(parent,['Save','Store'],'same');
  assert.throws(()=>evaluateWindowsUiaSemanticCandidateBatch(parent,[proposed,proposed],cases),/candidate-batch-duplicate/);
});

test('candidate batch rejects broken revision lineage instead of comparing unrelated recipes',()=>{
  const parent=base();
  const unrelated=Object.freeze({...child(parent,['Save','Store'],'bad'),parentDigest:`sha256:${'0'.repeat(64)}`});
  assert.throws(()=>evaluateWindowsUiaSemanticCandidateBatch(parent,[unrelated],cases),/parent-mismatch/);
});
