import test from 'node:test';
import assert from 'node:assert/strict';
import type { WindowsUiaCachedObservation } from '../src/computer/windowsUiaContract.js';
import { selectWindowsUiaSemanticBalancedReplayCases } from '../src/computer/windowsUiaSemanticReplaySampling.js';

const observation=Object.freeze({}) as WindowsUiaCachedObservation;
const replay=(caseId:string,applicationId?:string,providerFamily?:string,partition?:'development'|'holdout')=>Object.freeze({
  caseId,...(applicationId?{applicationId}:{}),...(providerFamily?{providerFamily}:{}),...(partition?{partition}:{}),observation,
});

test('balanced replay sampling caps each partition/application/provider domain independently',()=>{
  const result=selectWindowsUiaSemanticBalancedReplayCases([
    replay('dev-c','app-a','provider-a','development'),
    replay('dev-a','app-a','provider-a','development'),
    replay('dev-b','app-a','provider-a','development'),
    replay('holdout-a','app-a','provider-a','holdout'),
    replay('other-a','app-b','provider-b','development'),
  ],1);
  assert.equal(result.originalCases,5);
  assert.equal(result.selectedCases,3);
  assert.deepEqual(result.cases.map((entry)=>entry.caseId),['dev-a','other-a','holdout-a']);
  assert.deepEqual(result.domains,[
    {domainId:'development:app-a:provider-a',available:3,selected:1,dropped:2},
    {domainId:'development:app-b:provider-b',available:1,selected:1,dropped:0},
    {domainId:'holdout:app-a:provider-a',available:1,selected:1,dropped:0},
  ]);
});

test('balanced replay sampling is deterministic under input reordering',()=>{
  const a=replay('case-a','app-a','provider-a');
  const b=replay('case-b','app-a','provider-a');
  const c=replay('case-c','app-b','provider-b');
  const first=selectWindowsUiaSemanticBalancedReplayCases([b,c,a],1);
  const second=selectWindowsUiaSemanticBalancedReplayCases([a,b,c],1);
  assert.deepEqual(first.cases.map((entry)=>entry.caseId),second.cases.map((entry)=>entry.caseId));
  assert.deepEqual(first.domains,second.domains);
});

test('unlabeled replay evidence stays in an explicit unknown development domain',()=>{
  const result=selectWindowsUiaSemanticBalancedReplayCases([replay('unknown-one'),replay('unknown-two')],1);
  assert.deepEqual(result.domains,[{domainId:'development:unknown-app:unknown-provider',available:2,selected:1,dropped:1}]);
  assert.equal(result.cases[0]?.caseId,'unknown-one');
});

test('sampling validates budgets, exact case identity, and bounded domain labels',()=>{
  assert.throws(()=>selectWindowsUiaSemanticBalancedReplayCases([],1),/sampling-invalid/);
  assert.throws(()=>selectWindowsUiaSemanticBalancedReplayCases([replay('one')],0),/sampling-invalid/);
  assert.throws(()=>selectWindowsUiaSemanticBalancedReplayCases([replay('same'),replay('same')],1),/case-id-invalid/);
  assert.throws(()=>selectWindowsUiaSemanticBalancedReplayCases([replay('one','bad app','provider')],1),/application-id-invalid/);
  assert.throws(()=>selectWindowsUiaSemanticBalancedReplayCases([replay('one','app','bad provider')],1),/provider-family-invalid/);
});

test('sampling budget never becomes promotion, threshold, or execution authority',()=>{
  const result=selectWindowsUiaSemanticBalancedReplayCases([replay('one','app-a','provider-a')],1);
  assert.equal(result.maxCasesPerDomain,1);
  assert.equal(result.thresholdApplied,false);
  assert.equal(result.promotionEligible,false);
  assert.equal(result.authorityGranted,false);
  assert.equal('approved' in result,false);
  assert.equal('dispatch' in result,false);
  assert.equal('active' in result,false);
});
