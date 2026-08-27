import test from 'node:test';
import assert from 'node:assert/strict';
import {
  COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS,
  evaluateComputerUseProductionGate,
  validateComputerUseProductionGatePolicy,
  type ComputerUseProductionGatePolicy,
} from '../src/computer/computerUseProductionGate.js';
import {
  COMPUTER_USE_EVALUATION_STRATA,
  type ComputerUseEvaluationCaseResult,
} from '../src/computer/computerUseEvaluation.js';
import { DP11_WINDOWS_EMPIRICAL_BASELINE_CASES } from '../src/computer/dp11WindowsEmpiricalEvaluation.js';

function policy(minAttempted=1):ComputerUseProductionGatePolicy{
  return {
    policyId:'test-production-policy',
    stratumRequirements:COMPUTER_USE_EVALUATION_STRATA.map((stratum)=>({
      stratum,minAttempted,minSuccessRate:1,maxFailed:0,maxUnknown:0,
    })),
    claimRequirements:COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS.map((claim)=>({claim,minPassingCases:1})),
    requiredSourceKinds:['automated-test','execution-receipt'],
  };
}

function corpus():ComputerUseEvaluationCaseResult[]{
  return COMPUTER_USE_EVALUATION_STRATA.map((stratum,index)=>({
    caseId:`prod-case-${index}`,
    stratum,
    outcome:'passed' as const,
    sources:[
      {kind:'automated-test' as const,sourceId:`test-${index}`,gitSha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},
      {kind:'execution-receipt' as const,sourceId:`receipt-${index}`,gitSha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'},
    ],
  }));
}

function claimEvidence(caseId:string){
  return COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS.map((claim)=>({claim,caseIds:[caseId]}));
}

test('production gate can pass only under an explicit complete policy and sourced passing corpus',()=>{
  const cases=corpus();
  const decision=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(cases[0]!.caseId));
  assert.equal(decision.eligible,true);
  assert.equal(decision.authorityGranted,false);
  assert.deepEqual(decision.blockers,[]);
  assert.equal(decision.satisfiedClaims.length,COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS.length);
});

test('current DP11 empirical baseline stays blocked by stricter quantitative breadth policy',()=>{
  const decision=evaluateComputerUseProductionGate(
    policy(2),
    DP11_WINDOWS_EMPIRICAL_BASELINE_CASES,
    claimEvidence(DP11_WINDOWS_EMPIRICAL_BASELINE_CASES[0]!.caseId),
  );
  assert.equal(decision.eligible,false);
  assert.equal(decision.authorityGranted,false);
  for(const stratum of COMPUTER_USE_EVALUATION_STRATA){
    assert.ok(decision.blockers.includes(`stratum:${stratum}:attempted-below-threshold`));
  }
});

test('production gate refuses missing source classes and non-passing claim evidence',()=>{
  const cases=corpus();
  cases[0]={...cases[0]!,outcome:'unknown',sources:[{kind:'automated-test',sourceId:'test-0',gitSha:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'}]};
  const decision=evaluateComputerUseProductionGate(policy(),cases,claimEvidence(cases[0]!.caseId));
  assert.equal(decision.eligible,false);
  assert.ok(decision.blockers.includes('stratum:grounding:unknown-above-threshold'));
  assert.ok(decision.blockers.includes('claim:no-blind-retry-after-possible-dispatch:case-not-passed:prod-case-0'));
});

test('production policy must enumerate every stratum and safety claim with bounded thresholds',()=>{
  const invalid={...policy(),claimRequirements:policy().claimRequirements.slice(1)};
  assert.throws(()=>validateComputerUseProductionGatePolicy(invalid),/computer-use-production-claim-policy-incomplete/);
  const badRate={...policy(),stratumRequirements:policy().stratumRequirements.map((entry,index)=>index===0?{...entry,minSuccessRate:1.1}:entry)};
  assert.throws(()=>validateComputerUseProductionGatePolicy(badRate),/computer-use-production-stratum-threshold-invalid/);
});
