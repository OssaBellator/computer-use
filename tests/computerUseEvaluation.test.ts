import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPUTER_USE_EVALUATION_STRATA,
  summarizeComputerUseEvaluation,
  validateEmpiricalComputerUseEvaluationCases,
  type ComputerUseEvaluationCaseResult,
} from '../src/computer/computerUseEvaluation.js';
import {
  DP11_WINDOWS_EMPIRICAL_BASELINE,
  DP11_WINDOWS_EMPIRICAL_BASELINE_CASES,
  DP11_WINDOWS_EMPIRICAL_EXPANDED,
  DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES,
  DP11_WINDOWS_PRODUCTION_CLAIM_EVIDENCE,
} from '../src/computer/dp11WindowsEmpiricalEvaluation.js';
import { COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS } from '../src/computer/computerUseProductionGate.js';

function passingCases():ComputerUseEvaluationCaseResult[]{
  return COMPUTER_USE_EVALUATION_STRATA.map((stratum,index)=>({
    caseId:`case-${index}`,
    stratum,
    outcome:'passed' as const,
    evidence:[`evidence-${index}`],
  }));
}

test('DKG85 evaluation requires all seven strata before complete/passing',()=>{
  const cases=passingCases();
  const incomplete=summarizeComputerUseEvaluation(cases.slice(0,-1));
  assert.equal(incomplete.complete,false);
  assert.equal(incomplete.passing,false);
  assert.deepEqual(incomplete.missingStrata,['hostile-content-prompt-injection']);
  const complete=summarizeComputerUseEvaluation(cases);
  assert.equal(complete.complete,true);
  assert.equal(complete.passing,true);
  assert.equal(complete.passedCases,7);
  assert.equal(complete.successRate,1);
});

test('DKG85 UNKNOWN or failed cases prevent passing and remain quantitative',()=>{
  const cases=passingCases();
  cases.push({caseId:'recovery-unknown',stratum:'recovery-fault-injection',outcome:'unknown'});
  cases.push({caseId:'grounding-failure',stratum:'grounding',outcome:'failed'});
  const summary=summarizeComputerUseEvaluation(cases);
  assert.equal(summary.complete,true);
  assert.equal(summary.passing,false);
  assert.equal(summary.unknownCases,1);
  assert.equal(summary.failedCases,1);
  const recovery=summary.strata.find((entry)=>entry.stratum==='recovery-fault-injection')!;
  assert.deepEqual({attempted:recovery.attempted,passed:recovery.passed,unknown:recovery.unknown,successRate:recovery.successRate,passing:recovery.passing},{attempted:2,passed:1,unknown:1,successRate:0.5,passing:false});
});

test('DKG85 skipped-only stratum stays missing rather than becoming coverage',()=>{
  const cases=passingCases().filter((entry)=>entry.stratum!=='cross-embodiment-equivalence');
  cases.push({caseId:'equivalence-skipped',stratum:'cross-embodiment-equivalence',outcome:'skipped'});
  const summary=summarizeComputerUseEvaluation(cases);
  assert.equal(summary.complete,false);
  assert.ok(summary.missingStrata.includes('cross-embodiment-equivalence'));
  const equivalence=summary.strata.find((entry)=>entry.stratum==='cross-embodiment-equivalence')!;
  assert.deepEqual({attempted:equivalence.attempted,skipped:equivalence.skipped,complete:equivalence.complete},{attempted:0,skipped:1,complete:false});
});

test('DKG85 empirical cases require bounded replay-identifiable provenance',()=>{
  assert.throws(()=>validateEmpiricalComputerUseEvaluationCases([{
    caseId:'empirical-without-source',stratum:'primitive-action',outcome:'passed',evidence:['uia-invoke'],
  }]),/empirical-source-required/);
  assert.doesNotThrow(()=>validateEmpiricalComputerUseEvaluationCases([{
    caseId:'empirical-with-source',stratum:'primitive-action',outcome:'passed',evidence:['uia-invoke'],
    sources:[{kind:'windows-vm-smoke',sourceId:'vm-semantic-only',gitSha:'a43015db804b28b338af1a9cd76c00e1df860895'}],
  }]));
  assert.throws(()=>summarizeComputerUseEvaluation([{
    caseId:'bad-source-sha',stratum:'primitive-action',outcome:'passed',
    sources:[{kind:'automated-test',sourceId:'test-case',gitSha:'short'}],
  }]),/source-git-sha-invalid/);
});

test('DKG85 DP11 Windows baseline covers all seven strata without claiming the production gate',()=>{
  assert.equal(DP11_WINDOWS_EMPIRICAL_BASELINE_CASES.length,7);
  assert.equal(DP11_WINDOWS_EMPIRICAL_BASELINE.summary.complete,true);
  assert.equal(DP11_WINDOWS_EMPIRICAL_BASELINE.summary.passing,true);
  assert.equal(DP11_WINDOWS_EMPIRICAL_BASELINE.productionGateSatisfied,false);
  assert.equal(DP11_WINDOWS_EMPIRICAL_BASELINE.summary.missingStrata.length,0);
  for(const entry of DP11_WINDOWS_EMPIRICAL_BASELINE_CASES){
    assert.equal(entry.outcome,'passed');
    assert.ok(entry.sources && entry.sources.length>0);
  }
  const equivalence=DP11_WINDOWS_EMPIRICAL_BASELINE_CASES.find((entry)=>entry.stratum==='cross-embodiment-equivalence')!;
  assert.deepEqual(equivalence.sources?.map((source)=>source.kind),['windows-vm-smoke','windows-vm-smoke']);
});

test('DKG85 expanded provider-diversity corpus retains protected-VM WPF grounding failure instead of hiding it',()=>{
  assert.equal(DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES.length,47);
  assert.equal(DP11_WINDOWS_EMPIRICAL_EXPANDED.summary.complete,true);
  assert.equal(DP11_WINDOWS_EMPIRICAL_EXPANDED.summary.passing,false);
  assert.equal(DP11_WINDOWS_EMPIRICAL_EXPANDED.productionGateSatisfied,false);
  assert.equal(DP11_WINDOWS_EMPIRICAL_EXPANDED.summary.failedCases,1);
  const primitive=DP11_WINDOWS_EMPIRICAL_EXPANDED.summary.strata.find((entry)=>entry.stratum==='primitive-action')!;
  const verification=DP11_WINDOWS_EMPIRICAL_EXPANDED.summary.strata.find((entry)=>entry.stratum==='state-transition-verification')!;
  assert.equal(primitive.attempted,15);
  assert.equal(verification.attempted,8);
  assert.equal(DP11_WINDOWS_EMPIRICAL_EXPANDED.summary.strata.find((entry)=>entry.stratum==='grounding')!.attempted,6);
  assert.equal(DP11_WINDOWS_EMPIRICAL_EXPANDED.summary.strata.find((entry)=>entry.stratum==='recovery-fault-injection')!.attempted,9);
  const foregroundRefusal=DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES.find((entry)=>entry.caseId==='dp11-wpf-provider-unavailable-foreground-refusal')!;
  assert.equal(foregroundRefusal.outcome,'passed');
  assert.ok(foregroundRefusal.evidence?.includes('no-raw-dispatch'));
  assert.equal(foregroundRefusal.sources?.[0]?.sourceId,'uca_dp11_wpf_sha_pinned_vm_0827_02');
  const semanticSuccess=DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES.find((entry)=>entry.caseId==='dp11-wpf-semantic-success-no-fallback')!;
  assert.equal(semanticSuccess.outcome,'passed');
  assert.ok(semanticSuccess.evidence?.includes('no-raw-fallback'));
  assert.equal(semanticSuccess.sources?.[0]?.sourceId,'uca_dp11_wpf_sha_pinned_host_0827_01');
  assert.equal(DP11_WINDOWS_EMPIRICAL_EXPANDED.summary.strata.find((entry)=>entry.stratum==='long-horizon-mixed-interface')!.attempted,5);
  assert.equal(DP11_WINDOWS_EMPIRICAL_EXPANDED.summary.strata.find((entry)=>entry.stratum==='hostile-content-prompt-injection')!.attempted,3);
  const semanticRepeats=DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES.filter((entry)=>entry.caseId.startsWith('dp11-vm-semantic-repeat-')&&entry.stratum==='primitive-action');
  const rawRepeats=DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES.filter((entry)=>entry.caseId.startsWith('dp11-vm-raw-repeat-'));
  assert.equal(semanticRepeats.length,5);
  assert.equal(rawRepeats.length,5);
  assert.equal(new Set(semanticRepeats.flatMap((entry)=>entry.sources?.map((source)=>source.sourceId)??[])).size,1);
  assert.equal(new Set(rawRepeats.flatMap((entry)=>entry.sources?.map((source)=>source.sourceId)??[])).size,1);
  const raw=DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES.find((entry)=>entry.caseId==='dp11-vm-raw-primitive-actions')!;
  assert.equal(raw.outcome,'passed');
  assert.equal(raw.embodiment,'raw-coordinate');
  const wpfHost=DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES.find((entry)=>entry.caseId==='dp11-wpf-host-primitive-actions')!;
  assert.equal(wpfHost.outcome,'passed');
  assert.deepEqual(wpfHost.sources?.map((source)=>source.kind),['windows-host-smoke']);
  const win32Host=DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES.find((entry)=>entry.caseId==='dp11-win32-host-primitive-actions')!;
  const win32Vm=DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES.find((entry)=>entry.caseId==='dp11-win32-vm-primitive-actions')!;
  assert.equal(win32Host.outcome,'passed');
  assert.equal(win32Vm.outcome,'passed');
  assert.equal(win32Host.sources?.[0]?.sourceId,'uca_dp11_win32_pinned_host_0827_02');
  assert.equal(win32Vm.sources?.[0]?.sourceId,'uca_dp11_win32_pinned_vm_0827_01');
  const win32Verification=DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES.find((entry)=>entry.caseId==='dp11-win32-host-vm-state-verification')!;
  assert.deepEqual(win32Verification.sources?.map((source)=>source.kind),['windows-host-smoke','windows-vm-smoke']);
  const campaign=DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES.filter((entry)=>entry.caseId.startsWith('dp11-campaign-'));
  assert.equal(campaign.length,14);
  assert.ok(campaign.every((entry)=>entry.outcome==='passed'&&entry.sources?.some((source)=>source.kind==='automated-test')&&entry.sources?.some((source)=>source.kind==='execution-receipt')));
  const wpfVm=DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES.find((entry)=>entry.caseId==='dp11-wpf-protected-vm-tree-discovery-blocked')!;
  assert.equal(wpfVm.outcome,'failed');
  assert.ok(wpfVm.evidence?.includes('no-semantic-action-dispatch'));
  assert.deepEqual(wpfVm.sources?.map((source)=>source.kind),['windows-vm-smoke']);
});

test('DP11 production claim evidence covers every hard safety claim with passing sourced cases',()=>{
  assert.equal(DP11_WINDOWS_PRODUCTION_CLAIM_EVIDENCE.length,COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS.length);
  assert.deepEqual(new Set(DP11_WINDOWS_PRODUCTION_CLAIM_EVIDENCE.map((entry)=>entry.claim)),new Set(COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS));
  const byId=new Map(DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES.map((entry)=>[entry.caseId,entry] as const));
  for(const claim of DP11_WINDOWS_PRODUCTION_CLAIM_EVIDENCE){
    assert.ok(claim.caseIds.length>0);
    for(const caseId of claim.caseIds){
      const entry=byId.get(caseId);
      assert.ok(entry,`missing case ${caseId}`);
      assert.equal(entry?.outcome,'passed',`claim ${claim.claim} references non-passing case ${caseId}`);
      assert.ok(entry?.sources && entry.sources.length>0);
    }
  }
  const privacy=byId.get('dp11-release-privacy-credential-retention')!;
  assert.ok(privacy.evidence?.includes('credential-response-secret-rejected'));
  const disablement=byId.get('dp11-release-disablement-no-authority-inheritance')!;
  assert.ok(disablement.evidence?.includes('cu-level-authority-never-granted'));
});

test('DKG85 repeated trials are counted quantitatively without manufacturing case breadth',()=>{
  const summary=summarizeComputerUseEvaluation([{
    caseId:'ten-trial-semantic',stratum:'primitive-action',outcome:'passed',trials:10,embodiment:'semantic-ui',
    sources:[{kind:'windows-vm-smoke',sourceId:'semantic-ten',gitSha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}],
  }]);
  const primitive=summary.strata.find((entry)=>entry.stratum==='primitive-action')!;
  assert.deepEqual({attempted:primitive.attempted,trials:primitive.attemptedTrials,passedTrials:primitive.passedTrials,successRate:primitive.successRate},{attempted:1,trials:10,passedTrials:10,successRate:1});
  assert.throws(()=>summarizeComputerUseEvaluation([{caseId:'bad-trials',stratum:'primitive-action',outcome:'passed',trials:0}]),/computer-use-evaluation-trials-invalid/);
});

test('DKG85 case ledger rejects duplicate and malformed evidence instead of obscuring evaluation identity',()=>{
  assert.throws(()=>summarizeComputerUseEvaluation([
    {caseId:'dup',stratum:'grounding',outcome:'passed'},
    {caseId:'dup',stratum:'primitive-action',outcome:'passed'},
  ]),/computer-use-evaluation-case-duplicate/);
  assert.throws(()=>summarizeComputerUseEvaluation([
    {caseId:'bad-evidence',stratum:'grounding',outcome:'passed',evidence:['not allowed whitespace']},
  ]),/computer-use-evaluation-evidence-invalid/);
});
