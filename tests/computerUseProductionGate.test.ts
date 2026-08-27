import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS,
  COMPUTER_USE_ZERO_TOLERANCE_INCIDENTS,
  evaluateComputerUseProductionGate,
  validateComputerUseProductionGatePolicy,
  type ComputerUseProductionGatePolicy,
  type ComputerUseProductionReleaseEnvironmentEvidence,
  type ComputerUseProductionRuntimeProof,
} from '../src/computer/computerUseProductionGate.js';
import {
  COMPUTER_USE_EVALUATION_STRATA,
  type ComputerUseEvaluationCaseResult,
} from '../src/computer/computerUseEvaluation.js';
import { COMPUTER_USE_ENABLEMENT_LEVELS, type ComputerUseEnablementLevelPolicy } from '../src/computer/computerUseProgressiveEnablement.js';
import {
  DP11_WINDOWS_EMPIRICAL_BASELINE_CASES,
  DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES,
  DP11_WINDOWS_PRODUCTION_CLAIM_EVIDENCE,
} from '../src/computer/dp11WindowsEmpiricalEvaluation.js';

function policy(minAttempted=1):ComputerUseProductionGatePolicy{
  return {
    policyId:'test-production-policy',
    stratumRequirements:COMPUTER_USE_EVALUATION_STRATA.map((stratum)=>({
      stratum,minAttempted,minAttemptedTrials:minAttempted,minSuccessRate:1,maxFailed:0,maxUnknown:0,minDistinctEmbodiments:1,minDistinctSources:1,
    })),
    claimRequirements:COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS.map((claim)=>({claim,minPassingCases:1})),
    requiredSourceKinds:['automated-test','execution-receipt'],
    requiredReleaseEnvironments:['test-release-environment'],
  };
}

function corpus():ComputerUseEvaluationCaseResult[]{
  return COMPUTER_USE_EVALUATION_STRATA.map((stratum,index)=>({
    caseId:`prod-case-${index}`,
    stratum,
    outcome:'passed' as const,
    embodiment:'semantic-ui',
    sources:[
      {kind:'automated-test' as const,sourceId:`test-${index}`,gitSha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},
      {kind:'execution-receipt' as const,sourceId:`receipt-${index}`,gitSha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},
    ],
  }));
}
function claimEvidence(caseId:string){
  return COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS.map((claim)=>({claim,caseIds:[caseId]}));
}
function releaseEnvironmentEvidence(caseId:string,sourceId='test-0'):ComputerUseProductionReleaseEnvironmentEvidence[]{
  return [{environmentId:'test-release-environment',bindings:[{caseId,sourceId}]}];
}
function emptyEnablementPolicies():ComputerUseEnablementLevelPolicy[]{
  return COMPUTER_USE_ENABLEMENT_LEVELS.map((level)=>({level,requiredCapabilities:[]}));
}
function runtimeProof(disablementCaseId:string):ComputerUseProductionRuntimeProof{
  return {
    zeroToleranceIncidents:Object.fromEntries(COMPUTER_USE_ZERO_TOLERANCE_INCIDENTS.map((incident)=>[incident,0])) as ComputerUseProductionRuntimeProof['zeroToleranceIncidents'],
    enablement:{capabilityProfile:{id:'test-profile',capabilities:{}},policies:emptyEnablementPolicies(),targetLevel:'CU-0',rolloutCaseIds:[disablementCaseId],disablementCaseIds:[disablementCaseId]},
  };
}

test('production gate can pass only under explicit policy, sourced corpus, zero incidents, and eligible CU policy',()=>{
  const cases=corpus();
  const decision=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(cases[0]!.caseId),runtimeProof(cases[0]!.caseId),releaseEnvironmentEvidence(cases[0]!.caseId));
  assert.equal(decision.eligible,true);
  assert.equal(decision.authorityGranted,false);
  assert.equal(decision.targetEnablement.eligible,true);
  assert.deepEqual(decision.blockers,[]);
  assert.deepEqual(decision.stratumBreadth.map((entry)=>({stratum:entry.stratum,attempted:entry.attempted,trials:entry.attemptedTrials,embodiments:entry.distinctEmbodiments,sources:entry.distinctSources})),
    COMPUTER_USE_EVALUATION_STRATA.map((stratum)=>({stratum,attempted:1,trials:1,embodiments:1,sources:2})));
});

test('current DP11 empirical baseline stays blocked by stricter quantitative breadth policy',()=>{
  const decision=evaluateComputerUseProductionGate(
    policy(2),DP11_WINDOWS_EMPIRICAL_BASELINE_CASES,
    claimEvidence(DP11_WINDOWS_EMPIRICAL_BASELINE_CASES[0]!.caseId),
    runtimeProof(DP11_WINDOWS_EMPIRICAL_BASELINE_CASES[0]!.caseId),
    [],
  );
  assert.equal(decision.eligible,false);
  assert.equal(decision.authorityGranted,false);
  for(const stratum of COMPUTER_USE_EVALUATION_STRATA)assert.ok(decision.blockers.includes(`stratum:${stratum}:attempted-below-threshold`));
});

test('current DP11 expanded corpus and claim map remain production-blocked under strict quantitative policy',()=>{
  const disablement='dp11-release-disablement-no-authority-inheritance';
  const proof=runtimeProof(disablement);
  const decision=evaluateComputerUseProductionGate(
    policy(2),DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES,DP11_WINDOWS_PRODUCTION_CLAIM_EVIDENCE,
    {...proof,enablement:{...proof.enablement,rolloutCaseIds:[]}},[],
  );
  assert.equal(decision.eligible,false);
  assert.equal(decision.authorityGranted,false);
  assert.ok(decision.blockers.includes('stratum:grounding:failures-above-threshold'));
  assert.ok(decision.blockers.includes('release-environment:test-release-environment:evidence-missing'));
  assert.ok(decision.blockers.includes('enablement:CU-0:rollout-evidence-missing'));
});

test('production breadth policy rejects repeated single-embodiment or single-source evidence',()=>{
  const cases=corpus();
  const strict={
    ...policy(),
    stratumRequirements:policy().stratumRequirements.map((entry)=>entry.stratum==='primitive-action'?{...entry,minDistinctEmbodiments:2,minDistinctSources:3}:entry),
  };
  const decision=evaluateComputerUseProductionGate(strict,cases,claimEvidence(cases[0]!.caseId),runtimeProof(cases[0]!.caseId),releaseEnvironmentEvidence(cases[0]!.caseId));
  assert.equal(decision.eligible,false);
  assert.ok(decision.blockers.includes('stratum:primitive-action:embodiment-breadth-below-threshold'));
  assert.ok(decision.blockers.includes('stratum:primitive-action:source-breadth-below-threshold'));
  const measured=decision.stratumBreadth.find((entry)=>entry.stratum==='primitive-action')!;
  assert.deepEqual({attempted:measured.attempted,trials:measured.attemptedTrials,embodiments:measured.distinctEmbodiments,sources:measured.distinctSources},{attempted:1,trials:1,embodiments:1,sources:2});
});

test('production repetition threshold is independent from case/source/embodiment breadth',()=>{
  const cases=corpus();
  cases[1]={...cases[1]!,trials:10};
  const strict={...policy(),stratumRequirements:policy().stratumRequirements.map((entry)=>entry.stratum==='primitive-action'?{...entry,minAttemptedTrials:10}:entry)};
  const decision=evaluateComputerUseProductionGate(strict,cases,claimEvidence(cases[0]!.caseId),runtimeProof(cases[0]!.caseId),releaseEnvironmentEvidence(cases[0]!.caseId));
  const measured=decision.stratumBreadth.find((entry)=>entry.stratum==='primitive-action')!;
  assert.equal(measured.attempted,1);
  assert.equal(measured.attemptedTrials,10);
  assert.equal(measured.distinctEmbodiments,1);
  assert.equal(measured.distinctSources,2);
  assert.ok(!decision.blockers.includes('stratum:primitive-action:trials-below-threshold'));
});

test('zero-tolerance safety incidents block release regardless of quantitative policy thresholds',()=>{
  const cases=corpus();
  const proof=runtimeProof(cases[0]!.caseId);
  const decision=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(cases[0]!.caseId),{
    ...proof,
    zeroToleranceIncidents:{...proof.zeroToleranceIncidents,'blind-retry-after-possible-dispatch':1},
  },releaseEnvironmentEvidence(cases[0]!.caseId));
  assert.equal(decision.eligible,false);
  assert.ok(decision.blockers.includes('incident:blind-retry-after-possible-dispatch:nonzero'));
});

test('production rollout evidence is exact to the selected CU level and must reference passing cases',()=>{
  const cases=corpus();
  const caseId=cases[0]!.caseId;
  const proof=runtimeProof(caseId);
  const missing=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(caseId),{...proof,enablement:{...proof.enablement,rolloutCaseIds:[]}},releaseEnvironmentEvidence(caseId));
  assert.equal(missing.eligible,false);
  assert.ok(missing.blockers.includes('enablement:CU-0:rollout-evidence-missing'));
  const absent=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(caseId),{...proof,enablement:{...proof.enablement,rolloutCaseIds:['missing-rollout-case']}},releaseEnvironmentEvidence(caseId));
  assert.ok(absent.blockers.includes('enablement:CU-0:rollout-case-missing:missing-rollout-case'));
  const failedCases=cases.map((entry,index)=>index===0?{...entry,outcome:'failed' as const}:entry);
  const failed=evaluateComputerUseProductionGate(policy(),failedCases,claimEvidence(caseId),proof,releaseEnvironmentEvidence(caseId));
  assert.ok(failed.blockers.includes(`enablement:CU-0:rollout-case-not-passed:${caseId}`));
  assert.equal(failed.authorityGranted,false);
});

test('production target CU level must be eligible under the complete granular capability policy',()=>{
  const cases=corpus();
  const policies=emptyEnablementPolicies().map((entry)=>entry.level==='CU-1'?{...entry,requiredCapabilities:['pointer-input' as const]}:entry);
  const proof:ComputerUseProductionRuntimeProof={
    ...runtimeProof(cases[0]!.caseId),
    enablement:{capabilityProfile:{id:'partial-profile',capabilities:{'pointer-input':'partial'}},policies,targetLevel:'CU-1',rolloutCaseIds:[cases[0]!.caseId],disablementCaseIds:[cases[0]!.caseId]},
  };
  const decision=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(cases[0]!.caseId),proof,releaseEnvironmentEvidence(cases[0]!.caseId));
  assert.equal(decision.eligible,false);
  assert.ok(decision.blockers.includes('enablement:CU-1:capability-ineligible'));
  assert.equal(decision.authorityGranted,false);
});

test('release-environment proof must bind a required environment to a passing case and one of its replay-identifiable sources',()=>{
  const cases=corpus();
  const caseId=cases[0]!.caseId;
  const good=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(caseId),runtimeProof(caseId),releaseEnvironmentEvidence(caseId));
  assert.deepEqual(good.satisfiedReleaseEnvironments,['test-release-environment']);
  const missing=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(caseId),runtimeProof(caseId),[]);
  assert.ok(missing.blockers.includes('release-environment:test-release-environment:evidence-missing'));
  const wrongSource=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(caseId),runtimeProof(caseId),releaseEnvironmentEvidence(caseId,'not-a-source'));
  assert.ok(wrongSource.blockers.includes(`release-environment:test-release-environment:source-not-bound:${caseId}:not-a-source`));
  const failedCases=cases.map((entry)=>entry.caseId===caseId?{...entry,outcome:'failed' as const}:entry);
  const failed=evaluateComputerUseProductionGate(policy(),failedCases,claimEvidence(caseId),runtimeProof(caseId),releaseEnvironmentEvidence(caseId));
  assert.ok(failed.blockers.includes(`release-environment:test-release-environment:case-not-passed:${caseId}`));
});

test('production policy must enumerate every stratum and safety claim with bounded thresholds',()=>{
  const invalid={...policy(),claimRequirements:policy().claimRequirements.slice(1)};
  assert.throws(()=>validateComputerUseProductionGatePolicy(invalid),/computer-use-production-claim-policy-incomplete/);
  const badRate={...policy(),stratumRequirements:policy().stratumRequirements.map((entry,index)=>index===0?{...entry,minSuccessRate:1.1}:entry)};
  assert.throws(()=>validateComputerUseProductionGatePolicy(badRate),/computer-use-production-stratum-threshold-invalid/);
  assert.throws(()=>validateComputerUseProductionGatePolicy({...policy(),requiredReleaseEnvironments:[]}),/computer-use-production-release-environment-policy-invalid/);
  assert.throws(()=>validateComputerUseProductionGatePolicy({...policy(),requiredReleaseEnvironments:['same-environment','same-environment']}),/computer-use-production-release-environment-policy-invalid/);
});
