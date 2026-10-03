import test from 'node:test';
import assert from 'node:assert/strict';
import { DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES } from '../src/computer/dp11WindowsEmpiricalEvaluation.js';
import { assessWindowsUiaSemanticCorrectionEvidence } from '../src/computer/windowsUiaSemanticCorrectionEvidence.js';

const EXPLORER='xrc_mtbi8lrl_e5d9b80204456db1d1ba8908';
const TERMINAL='xrc_mtbiu7gu_962beef7a68663d3a7ce55df';
const EARLY_REAL_APP='xrc_mtbe4tif_fc491915f912baad0475752e';

test('correction evidence binds exact Explorer and Terminal receipts to empirical case/source provenance',()=>{
  const result=assessWindowsUiaSemanticCorrectionEvidence(DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES,[EXPLORER,TERMINAL]);
  assert.equal(result.status,'bound');
  assert.equal(result.promotionApproved,false);
  assert.equal(result.authorityGranted,false);
  assert.deepEqual(new Set(result.bindings.map((entry)=>entry.evidenceId)),new Set([EXPLORER,TERMINAL]));
  const explorer=result.bindings.filter((entry)=>entry.evidenceId===EXPLORER);
  const terminal=result.bindings.filter((entry)=>entry.evidenceId===TERMINAL);
  assert.equal(explorer.length,2);
  assert.equal(terminal.length,2);
  assert.ok(explorer.every((entry)=>entry.gitSha==='44c867c098b82ef33c7c3804d80a21a0c23238b0'&&entry.applicationId==='windows-file-explorer'));
  assert.ok(terminal.every((entry)=>entry.gitSha==='dd239ece29c603834ee218b7b7c8742a7f489238'&&entry.applicationId==='windows-terminal'&&entry.providerFamily==='cascadia-uia'));
});

test('failed empirical observations may motivate correction without being relabeled as success',()=>{
  const result=assessWindowsUiaSemanticCorrectionEvidence(DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES,[EARLY_REAL_APP]);
  assert.equal(result.status,'bound');
  assert.ok(result.bindings.some((entry)=>entry.caseId==='dp11-calculator-real-app-content-grounding-blocked'&&entry.outcome==='failed'));
  assert.ok(result.bindings.some((entry)=>entry.caseId==='dp11-notepad-real-app-semantic-value'&&entry.outcome==='passed'));
  assert.equal(result.promotionApproved,false);
  assert.equal(result.authorityGranted,false);
});

test('invented correction evidence cannot become provenance-bound',()=>{
  const invented='xrc_invented_correction_receipt';
  const result=assessWindowsUiaSemanticCorrectionEvidence(DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES,[invented]);
  assert.equal(result.status,'rejected');
  if(result.status==='rejected')assert.equal(result.reason,`evidence-source-missing:${invented}`);
  assert.equal(result.promotionApproved,false);
  assert.equal(result.authorityGranted,false);
});

test('correction evidence rejection preserves earlier bindings when a later source is missing',()=>{
  const missing='xrc_missing_after_explorer';
  const result=assessWindowsUiaSemanticCorrectionEvidence(DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES,[EXPLORER,missing]);
  assert.equal(result.status,'rejected');
  if(result.status==='rejected'){
    assert.equal(result.reason,`evidence-source-missing:${missing}`);
    assert.equal(result.bindings.length,2);
    assert.ok(result.bindings.every((entry)=>entry.evidenceId===EXPLORER));
  }
});

test('correction evidence preserves explicit missing-git-sha rejection for an existing source',()=>{
  const sourceId='source-without-sha';
  const result=assessWindowsUiaSemanticCorrectionEvidence([{
    caseId:'case-without-sha',stratum:'grounding',outcome:'failed',sources:[{kind:'windows-host-smoke',sourceId}],
  }],[sourceId]);
  assert.equal(result.status,'rejected');
  if(result.status==='rejected'){
    assert.equal(result.reason,`evidence-source-git-sha-missing:${sourceId}`);
    assert.deepEqual(result.bindings,[]);
  }
});

test('correction evidence identifiers remain bounded unique tokens',()=>{
  assert.throws(()=>assessWindowsUiaSemanticCorrectionEvidence(DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES,[]),/evidence-ids-invalid/);
  assert.throws(()=>assessWindowsUiaSemanticCorrectionEvidence(DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES,[EXPLORER,EXPLORER]),/evidence-ids-invalid/);
  assert.throws(()=>assessWindowsUiaSemanticCorrectionEvidence(DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES,['bad evidence id']),/evidence-ids-invalid/);
});
