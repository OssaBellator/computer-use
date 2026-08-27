import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS,
  COMPUTER_USE_ZERO_TOLERANCE_INCIDENTS,
  computerUseProductionPolicyDigest,
  evaluateComputerUseProductionGate,
  validateComputerUseProductionGatePolicy,
  type ComputerUseProductionGatePolicy,
  type ComputerUseProductionPolicyApproval,
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
      stratum,minAttempted,minAttemptedTrials:minAttempted,minSuccessRate:1,maxFailed:0,maxUnknown:0,minDistinctEmbodiments:1,minDistinctSources:1,minDistinctApplications:1,minDistinctProviderFamilies:1,
    })),
    claimRequirements:COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS.map((claim)=>({claim,minPassingCases:1})),
    requiredSourceKinds:['automated-test','execution-receipt'],
    minDistinctApplications:1,
    minDistinctProviderFamilies:1,
    requiredReleaseEnvironments:['test-release-environment'],
  };
}

function corpus():ComputerUseEvaluationCaseResult[]{
  return COMPUTER_USE_EVALUATION_STRATA.map((stratum,index)=>({
    caseId:`prod-case-${index}`,
    stratum,
    outcome:'passed' as const,
    embodiment:'semantic-ui',
    applicationId:'test-app',providerFamily:'test-provider',enablementLevel:'CU-0' as const,
    sources:[
      {kind:'automated-test' as const,sourceId:`test-${index}`,gitSha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',independenceId:`run-${index}`,environmentId:'test-release-environment'},
      {kind:'execution-receipt' as const,sourceId:`receipt-${index}`,gitSha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',independenceId:`run-${index}`,environmentId:'test-release-environment'},
    ],
  }));
}
function claimEvidence(caseId:string){
  return COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS.map((claim)=>({claim,caseIds:[caseId]}));
}
function policyApproval(value:ComputerUseProductionGatePolicy):ComputerUseProductionPolicyApproval{
  return {policyId:value.policyId,policyDigest:computerUseProductionPolicyDigest(value),approvalId:'test-policy-approval',reviewSourceId:'test-review-receipt',reviewGitSha:'cccccccccccccccccccccccccccccccccccccccc'};
}
function releaseEnvironmentEvidence(cases:readonly ComputerUseEvaluationCaseResult[],extraBinding?:Readonly<{caseId:string;sourceId:string}>):ComputerUseProductionReleaseEnvironmentEvidence[]{
  const bindings=cases.flatMap((entry)=>(entry.sources??[]).filter((source)=>source.environmentId==='test-release-environment').map((source)=>({caseId:entry.caseId,sourceId:source.sourceId})));
  if(extraBinding)bindings.push(extraBinding);
  return [{environmentId:'test-release-environment',bindings}];
}
function emptyEnablementPolicies():ComputerUseEnablementLevelPolicy[]{
  return COMPUTER_USE_ENABLEMENT_LEVELS.map((level)=>({level,requiredCapabilities:[]}));
}
function runtimeProof(disablementCaseId:string):ComputerUseProductionRuntimeProof{
  const zeroCounts=Object.fromEntries(COMPUTER_USE_ZERO_TOLERANCE_INCIDENTS.map((incident)=>[incident,0])) as ComputerUseProductionRuntimeProof['zeroToleranceIncidents'];
  return {
    zeroToleranceIncidents:zeroCounts,
    zeroToleranceIncidentEvidence:[{evidenceId:'test-incident-evidence',gitSha:'dddddddddddddddddddddddddddddddddddddddd',environmentId:'test-release-environment',counts:zeroCounts}],
    enablement:{capabilityProfile:{id:'test-profile',capabilities:{}},policies:emptyEnablementPolicies(),targetLevel:'CU-0',rolloutCaseIds:[disablementCaseId],disablementCaseIds:[disablementCaseId]},
  };
}

test('production gate can pass only under explicit policy, sourced corpus, zero incidents, and eligible CU policy',()=>{
  const cases=corpus();
  const approvedPolicy=policy();
  const decision=evaluateComputerUseProductionGate(approvedPolicy,cases,claimEvidence(cases[0]!.caseId),runtimeProof(cases[0]!.caseId),releaseEnvironmentEvidence(cases),policyApproval(approvedPolicy));
  assert.equal(decision.eligible,true);
  assert.equal(decision.authorityGranted,false);
  assert.equal(decision.targetEnablement.eligible,true);
  assert.equal(decision.policyApprovalSatisfied,true);
  assert.deepEqual(decision.blockers,[]);
  assert.deepEqual(decision.stratumBreadth.map((entry)=>({stratum:entry.stratum,attempted:entry.attempted,trials:entry.attemptedTrials,embodiments:entry.distinctEmbodiments,sources:entry.distinctSources})),
    COMPUTER_USE_EVALUATION_STRATA.map((stratum)=>({stratum,attempted:1,trials:1,embodiments:1,sources:1})));
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

test('production corpus diversity is independent from source and embodiment breadth',()=>{
  const cases=corpus();
  const strict={...policy(),minDistinctApplications:2,minDistinctProviderFamilies:2};
  const decision=evaluateComputerUseProductionGate(strict,cases,claimEvidence(cases[0]!.caseId),runtimeProof(cases[0]!.caseId),releaseEnvironmentEvidence(cases));
  assert.equal(decision.eligible,false);
  assert.deepEqual(decision.corpusDiversity,{distinctApplications:1,distinctProviderFamilies:1});
  assert.ok(decision.blockers.includes('corpus:application-breadth-below-threshold'));
  assert.ok(decision.blockers.includes('corpus:provider-family-breadth-below-threshold'));
});

test('production policy can require application and provider breadth inside a specific stratum',()=>{
  const cases=corpus();
  const strict={...policy(),stratumRequirements:policy().stratumRequirements.map((entry)=>entry.stratum==='primitive-action'?{...entry,minDistinctApplications:2,minDistinctProviderFamilies:2}:entry)};
  const decision=evaluateComputerUseProductionGate(strict,cases,claimEvidence(cases[0]!.caseId),runtimeProof(cases[0]!.caseId),releaseEnvironmentEvidence(cases));
  const measured=decision.stratumBreadth.find((entry)=>entry.stratum==='primitive-action')!;
  assert.equal(measured.distinctApplications,1);
  assert.equal(measured.distinctProviderFamilies,1);
  assert.ok(decision.blockers.includes('stratum:primitive-action:application-breadth-below-threshold'));
  assert.ok(decision.blockers.includes('stratum:primitive-action:provider-family-breadth-below-threshold'));
  assert.ok(decision.blockers.includes('release-environment:test-release-environment:stratum:primitive-action:application-breadth-below-threshold'));
  assert.ok(decision.blockers.includes('release-environment:test-release-environment:stratum:primitive-action:provider-family-breadth-below-threshold'));
});

test('production breadth policy rejects repeated single-embodiment or single-source evidence',()=>{
  const cases=corpus();
  const strict={
    ...policy(),
    stratumRequirements:policy().stratumRequirements.map((entry)=>entry.stratum==='primitive-action'?{...entry,minDistinctEmbodiments:2,minDistinctSources:3}:entry),
  };
  const decision=evaluateComputerUseProductionGate(strict,cases,claimEvidence(cases[0]!.caseId),runtimeProof(cases[0]!.caseId),releaseEnvironmentEvidence(cases));
  assert.equal(decision.eligible,false);
  assert.ok(decision.blockers.includes('stratum:primitive-action:embodiment-breadth-below-threshold'));
  assert.ok(decision.blockers.includes('stratum:primitive-action:source-breadth-below-threshold'));
  const measured=decision.stratumBreadth.find((entry)=>entry.stratum==='primitive-action')!;
  assert.deepEqual({attempted:measured.attempted,trials:measured.attemptedTrials,embodiments:measured.distinctEmbodiments,sources:measured.distinctSources},{attempted:1,trials:1,embodiments:1,sources:1});
});

test('production source breadth counts independent executions rather than metadata records from the same run',()=>{
  const cases=corpus();
  const base=cases[1]!;
  cases.push({...base,caseId:'prod-independent-peer',sources:[
    {kind:'automated-test',sourceId:'peer-test',gitSha:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',independenceId:'peer-run'},
    {kind:'execution-receipt',sourceId:'peer-receipt',gitSha:'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',independenceId:'peer-run'},
  ]});
  const strict={...policy(),stratumRequirements:policy().stratumRequirements.map((entry)=>entry.stratum==='primitive-action'?{...entry,minDistinctSources:2}:entry)};
  const decision=evaluateComputerUseProductionGate(strict,cases,claimEvidence(cases[0]!.caseId),runtimeProof(cases[0]!.caseId),releaseEnvironmentEvidence(cases));
  assert.equal(decision.stratumBreadth.find((entry)=>entry.stratum==='primitive-action')!.distinctSources,2);
  assert.ok(!decision.blockers.includes('stratum:primitive-action:source-breadth-below-threshold'));
});

test('production repetition threshold is independent from case/source/embodiment breadth',()=>{
  const cases=corpus();
  cases[1]={...cases[1]!,trials:10};
  const strict={...policy(),stratumRequirements:policy().stratumRequirements.map((entry)=>entry.stratum==='primitive-action'?{...entry,minAttemptedTrials:10}:entry)};
  const decision=evaluateComputerUseProductionGate(strict,cases,claimEvidence(cases[0]!.caseId),runtimeProof(cases[0]!.caseId),releaseEnvironmentEvidence(cases));
  const measured=decision.stratumBreadth.find((entry)=>entry.stratum==='primitive-action')!;
  assert.equal(measured.attempted,1);
  assert.equal(measured.attemptedTrials,10);
  assert.equal(measured.distinctEmbodiments,1);
  assert.equal(measured.distinctSources,1);
  assert.ok(!decision.blockers.includes('stratum:primitive-action:trials-below-threshold'));
});

test('zero-tolerance safety incidents block release regardless of quantitative policy thresholds',()=>{
  const cases=corpus();
  const proof=runtimeProof(cases[0]!.caseId);
  const nonzeroCounts={...proof.zeroToleranceIncidents,'blind-retry-after-possible-dispatch':1};
  const decision=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(cases[0]!.caseId),{
    ...proof,
    zeroToleranceIncidents:nonzeroCounts,
    zeroToleranceIncidentEvidence:proof.zeroToleranceIncidentEvidence.map((evidence)=>({...evidence,counts:nonzeroCounts})),
  },releaseEnvironmentEvidence(cases));
  assert.equal(decision.eligible,false);
  assert.ok(decision.blockers.includes('incident:blind-retry-after-possible-dispatch:nonzero'));
});

test('production rollout evidence is exact to the selected CU level and must reference passing cases',()=>{
  const cases=corpus();
  const caseId=cases[0]!.caseId;
  const proof=runtimeProof(caseId);
  const missing=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(caseId),{...proof,enablement:{...proof.enablement,rolloutCaseIds:[]}},releaseEnvironmentEvidence(cases));
  assert.equal(missing.eligible,false);
  assert.ok(missing.blockers.includes('enablement:CU-0:rollout-evidence-missing'));
  const absent=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(caseId),{...proof,enablement:{...proof.enablement,rolloutCaseIds:['missing-rollout-case']}},releaseEnvironmentEvidence(cases));
  assert.ok(absent.blockers.includes('enablement:CU-0:rollout-case-missing:missing-rollout-case'));
  const failedCases=cases.map((entry,index)=>index===0?{...entry,outcome:'failed' as const}:entry);
  const failed=evaluateComputerUseProductionGate(policy(),failedCases,claimEvidence(caseId),proof,releaseEnvironmentEvidence(cases));
  assert.ok(failed.blockers.includes(`enablement:CU-0:rollout-case-not-passed:${caseId}`));
  const missingLevelCases=cases.map((entry,index)=>index===0?{...entry,enablementLevel:undefined}:entry);
  const missingLevel=evaluateComputerUseProductionGate(policy(),missingLevelCases,claimEvidence(caseId),proof,releaseEnvironmentEvidence(cases));
  assert.ok(missingLevel.blockers.includes(`enablement:CU-0:rollout-case-level-missing:${caseId}`));
  const wrongLevelCases=cases.map((entry,index)=>index===0?{...entry,enablementLevel:'CU-1' as const}:entry);
  const wrongLevel=evaluateComputerUseProductionGate(policy(),wrongLevelCases,claimEvidence(caseId),proof,releaseEnvironmentEvidence(cases));
  assert.ok(wrongLevel.blockers.includes(`enablement:CU-0:rollout-case-level-mismatch:${caseId}:CU-1`));
  assert.ok(wrongLevel.blockers.includes(`disablement:CU-0:case-level-mismatch:${caseId}:CU-1`));
  const missingDisablementLevel=evaluateComputerUseProductionGate(policy(),missingLevelCases,claimEvidence(caseId),proof,releaseEnvironmentEvidence(cases));
  assert.ok(missingDisablementLevel.blockers.includes(`disablement:CU-0:case-level-missing:${caseId}`));
  assert.equal(failed.authorityGranted,false);
});

test('production target CU level must be eligible under the complete granular capability policy',()=>{
  const cases=corpus();
  const policies=emptyEnablementPolicies().map((entry)=>entry.level==='CU-1'?{...entry,requiredCapabilities:['pointer-input' as const]}:entry);
  const proof:ComputerUseProductionRuntimeProof={
    ...runtimeProof(cases[0]!.caseId),
    enablement:{capabilityProfile:{id:'partial-profile',capabilities:{'pointer-input':'partial'}},policies,targetLevel:'CU-1',rolloutCaseIds:[cases[0]!.caseId],disablementCaseIds:[cases[0]!.caseId]},
  };
  const levelCases=cases.map((entry,index)=>index===0?{...entry,enablementLevel:'CU-1' as const}:entry);
  const decision=evaluateComputerUseProductionGate(policy(),levelCases,claimEvidence(cases[0]!.caseId),proof,releaseEnvironmentEvidence(cases));
  assert.equal(decision.eligible,false);
  assert.ok(decision.blockers.includes('enablement:CU-1:capability-ineligible'));
  assert.equal(decision.authorityGranted,false);
});

test('release-environment proof must bind a required environment to a passing case and one of its replay-identifiable sources',()=>{
  const cases=corpus();
  const caseId=cases[0]!.caseId;
  const good=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(caseId),runtimeProof(caseId),releaseEnvironmentEvidence(cases));
  assert.deepEqual(good.satisfiedReleaseEnvironments,['test-release-environment']);
  assert.equal(good.releaseEnvironmentCoverage[0]?.attemptedCases,COMPUTER_USE_EVALUATION_STRATA.length);
  assert.ok(good.releaseEnvironmentCoverage[0]?.stratumBreadth.every((entry)=>entry.attempted===1&&entry.distinctSources===1));
  assert.deepEqual(good.releaseEnvironmentCoverage[0]?.satisfiedClaims,COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS);
  assert.equal(good.releaseEnvironmentCoverage[0]?.rolloutEvidenceSatisfied,true);
  assert.equal(good.releaseEnvironmentCoverage[0]?.disablementEvidenceSatisfied,true);
  assert.equal(good.releaseEnvironmentCoverage[0]?.zeroToleranceIncidentEvidenceSatisfied,true);
  const partial=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(caseId),runtimeProof(caseId),[{environmentId:'test-release-environment',bindings:[{caseId,sourceId:'test-0'}]}]);
  assert.ok(partial.blockers.includes('release-environment:test-release-environment:case-unbound:prod-case-1'));
  const outsideClaimCase={...cases[0]!,caseId:'outside-claim-case',sources:cases[0]!.sources?.map((source)=>({...source,sourceId:`outside-${source.sourceId}`,environmentId:'other-environment'}))};
  const mixedCases=[...cases,outsideClaimCase];
  const mixedClaims=claimEvidence(caseId).map((entry)=>entry.claim==='no-blind-retry-after-possible-dispatch'?{...entry,caseIds:[outsideClaimCase.caseId]}:entry);
  const environmentClaimGap=evaluateComputerUseProductionGate(policy(),mixedCases,mixedClaims,runtimeProof(caseId),releaseEnvironmentEvidence(mixedCases));
  assert.ok(!environmentClaimGap.blockers.includes('claim:no-blind-retry-after-possible-dispatch:passing-cases-below-threshold'));
  assert.ok(environmentClaimGap.blockers.includes('release-environment:test-release-environment:claim:no-blind-retry-after-possible-dispatch:passing-cases-below-threshold'));
  const environmentEnablementProof=runtimeProof(outsideClaimCase.caseId);
  const environmentEnablementGap=evaluateComputerUseProductionGate(policy(),mixedCases,claimEvidence(caseId),environmentEnablementProof,releaseEnvironmentEvidence(mixedCases));
  assert.ok(!environmentEnablementGap.blockers.includes(`enablement:CU-0:rollout-case-not-passed:${outsideClaimCase.caseId}`));
  assert.ok(environmentEnablementGap.blockers.includes('release-environment:test-release-environment:enablement:CU-0:rollout-evidence-missing'));
  assert.ok(environmentEnablementGap.blockers.includes('release-environment:test-release-environment:enablement:CU-0:disablement-evidence-missing'));
  const incidentProof=runtimeProof(caseId);
  const wrongIncidentEnvironment=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(caseId),{...incidentProof,zeroToleranceIncidentEvidence:incidentProof.zeroToleranceIncidentEvidence.map((evidence)=>({...evidence,environmentId:'other-environment'}))},releaseEnvironmentEvidence(cases));
  assert.ok(wrongIncidentEnvironment.blockers.includes('release-environment:test-release-environment:incident-evidence-missing'));
  assert.throws(()=>evaluateComputerUseProductionGate(policy(),cases,claimEvidence(caseId),{...incidentProof,zeroToleranceIncidents:{...incidentProof.zeroToleranceIncidents,'secret-exposure':1}},releaseEnvironmentEvidence(cases)),/computer-use-production-incident-evidence-count-mismatch:secret-exposure/);
  const strict=evaluateComputerUseProductionGate(policy(2),cases,claimEvidence(caseId),runtimeProof(caseId),releaseEnvironmentEvidence(cases));
  assert.ok(strict.blockers.includes('release-environment:test-release-environment:stratum:grounding:attempted-below-threshold')); 
  const missing=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(caseId),runtimeProof(caseId),[]);
  assert.ok(missing.blockers.includes('release-environment:test-release-environment:evidence-missing'));
  const wrongSource=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(caseId),runtimeProof(caseId),releaseEnvironmentEvidence(cases,{caseId,sourceId:'not-a-source'}));
  assert.ok(wrongSource.blockers.includes(`release-environment:test-release-environment:source-not-bound:${caseId}:not-a-source`));
  const wrongEnvironmentCases=cases.map((entry)=>entry.caseId===caseId?{...entry,sources:entry.sources?.map((source)=>source.sourceId==='test-0'?{...source,environmentId:'other-environment'}:source)}:entry);
  const wrongEnvironment=evaluateComputerUseProductionGate(policy(),wrongEnvironmentCases,claimEvidence(caseId),runtimeProof(caseId),releaseEnvironmentEvidence(cases));
  assert.ok(wrongEnvironment.blockers.includes(`release-environment:test-release-environment:source-environment-mismatch:${caseId}:test-0:other-environment`));
  const failedCases=cases.map((entry)=>entry.caseId===caseId?{...entry,outcome:'failed' as const}:entry);
  const failed=evaluateComputerUseProductionGate(policy(),failedCases,claimEvidence(caseId),runtimeProof(caseId),releaseEnvironmentEvidence(cases));
  assert.ok(failed.blockers.includes(`release-environment:test-release-environment:case-not-passed:${caseId}`));
});

test('production policy approval must bind the exact canonical policy contents to immutable review evidence',()=>{
  const cases=corpus();
  const p=policy();
  const caseId=cases[0]!.caseId;
  const args=[cases,claimEvidence(caseId),runtimeProof(caseId),releaseEnvironmentEvidence(cases)] as const;
  const missing=evaluateComputerUseProductionGate(p,...args);
  assert.equal(missing.policyApprovalSatisfied,false);
  assert.ok(missing.blockers.includes('policy:approval-missing'));
  const wrongId=evaluateComputerUseProductionGate(p,...args,{...policyApproval(p),policyId:'other-policy'});
  assert.ok(wrongId.blockers.includes('policy:approval-policy-id-mismatch:other-policy'));
  const stale={...p,minDistinctApplications:2};
  const staleDecision=evaluateComputerUseProductionGate(stale,...args,policyApproval(p));
  assert.ok(staleDecision.blockers.includes('policy:approval-digest-mismatch'));
  assert.throws(()=>evaluateComputerUseProductionGate(p,...args,{...policyApproval(p),reviewGitSha:'short'}),/computer-use-production-policy-approval-invalid/);
});

test('production policy must enumerate every stratum and safety claim with bounded thresholds',()=>{
  const invalid={...policy(),claimRequirements:policy().claimRequirements.slice(1)};
  assert.throws(()=>validateComputerUseProductionGatePolicy(invalid),/computer-use-production-claim-policy-incomplete/);
  const badRate={...policy(),stratumRequirements:policy().stratumRequirements.map((entry,index)=>index===0?{...entry,minSuccessRate:1.1}:entry)};
  assert.throws(()=>validateComputerUseProductionGatePolicy(badRate),/computer-use-production-stratum-threshold-invalid/);
  const badStratumDiversity={...policy(),stratumRequirements:policy().stratumRequirements.map((entry,index)=>index===0?{...entry,minDistinctApplications:0}:entry)};
  assert.throws(()=>validateComputerUseProductionGatePolicy(badStratumDiversity),/computer-use-production-stratum-threshold-invalid/);
  assert.throws(()=>validateComputerUseProductionGatePolicy({...policy(),minDistinctApplications:0}),/computer-use-production-corpus-diversity-policy-invalid/);
  assert.throws(()=>validateComputerUseProductionGatePolicy({...policy(),minDistinctProviderFamilies:0}),/computer-use-production-corpus-diversity-policy-invalid/);
  assert.throws(()=>validateComputerUseProductionGatePolicy({...policy(),requiredReleaseEnvironments:[]}),/computer-use-production-release-environment-policy-invalid/);
  assert.throws(()=>validateComputerUseProductionGatePolicy({...policy(),requiredReleaseEnvironments:['same-environment','same-environment']}),/computer-use-production-release-environment-policy-invalid/);
});
