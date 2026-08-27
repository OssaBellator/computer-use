import {
  COMPUTER_USE_EVALUATION_SOURCE_KINDS,
  COMPUTER_USE_EVALUATION_STRATA,
  summarizeComputerUseEvaluation,
  validateEmpiricalComputerUseEvaluationCases,
  type ComputerUseEvaluationCaseResult,
  type ComputerUseEvaluationSourceKind,
  type ComputerUseEvaluationStratum,
} from './computerUseEvaluation.js';

export const COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS = [
  'no-blind-retry-after-possible-dispatch',
  'no-dispatch-only-consequential-success',
  'authoritative-state-transition-verification',
  'hostile-content-authority-isolation',
  'human-interference-unknown-semantics',
  'routing-fallback-visibility',
  'recovery-fault-injection',
  'privacy-secret-retention',
  'cross-embodiment-authority-preservation',
  'long-horizon-auth-anti-rollback',
  'disablement-no-authority-inheritance',
] as const;

export type ComputerUseProductionSafetyClaim = typeof COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS[number];

export interface ComputerUseProductionStratumRequirement {
  readonly stratum:ComputerUseEvaluationStratum;
  readonly minAttempted:number;
  readonly minSuccessRate:number;
  readonly maxFailed:number;
  readonly maxUnknown:number;
}

export interface ComputerUseProductionClaimRequirement {
  readonly claim:ComputerUseProductionSafetyClaim;
  readonly minPassingCases:number;
}

export interface ComputerUseProductionClaimEvidence {
  readonly claim:ComputerUseProductionSafetyClaim;
  readonly caseIds:readonly string[];
}

export interface ComputerUseProductionGatePolicy {
  readonly policyId:string;
  readonly stratumRequirements:readonly ComputerUseProductionStratumRequirement[];
  readonly claimRequirements:readonly ComputerUseProductionClaimRequirement[];
  readonly requiredSourceKinds:readonly ComputerUseEvaluationSourceKind[];
}

export interface ComputerUseProductionGateDecision {
  readonly eligible:boolean;
  readonly authorityGranted:false;
  readonly blockers:readonly string[];
  readonly evaluation:ReturnType<typeof summarizeComputerUseEvaluation>;
  readonly satisfiedSourceKinds:readonly ComputerUseEvaluationSourceKind[];
  readonly satisfiedClaims:readonly ComputerUseProductionSafetyClaim[];
}

const TOKEN=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
const MAX_THRESHOLD=10_000;

function safeInt(value:unknown,min=0,max=MAX_THRESHOLD):value is number {
  return typeof value==='number'&&Number.isSafeInteger(value)&&value>=min&&value<=max;
}
function safeRate(value:unknown):value is number {
  return typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=1;
}

export function validateComputerUseProductionGatePolicy(policy:ComputerUseProductionGatePolicy):void {
  if(!policy||typeof policy!=='object'||!TOKEN.test(policy.policyId))throw new Error('computer-use-production-policy-id-invalid');
  if(!Array.isArray(policy.stratumRequirements)||policy.stratumRequirements.length!==COMPUTER_USE_EVALUATION_STRATA.length)
    throw new Error('computer-use-production-stratum-policy-incomplete');
  const strata=new Set<ComputerUseEvaluationStratum>();
  for(const item of policy.stratumRequirements){
    if(!item||typeof item!=='object'||!COMPUTER_USE_EVALUATION_STRATA.includes(item.stratum))throw new Error('computer-use-production-stratum-policy-invalid');
    if(strata.has(item.stratum))throw new Error('computer-use-production-stratum-policy-duplicate');
    strata.add(item.stratum);
    if(!safeInt(item.minAttempted,1)||!safeRate(item.minSuccessRate)||!safeInt(item.maxFailed)||!safeInt(item.maxUnknown))
      throw new Error('computer-use-production-stratum-threshold-invalid');
  }
  if(!Array.isArray(policy.claimRequirements)||policy.claimRequirements.length!==COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS.length)
    throw new Error('computer-use-production-claim-policy-incomplete');
  const claims=new Set<ComputerUseProductionSafetyClaim>();
  for(const item of policy.claimRequirements){
    if(!item||typeof item!=='object'||!COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS.includes(item.claim))throw new Error('computer-use-production-claim-policy-invalid');
    if(claims.has(item.claim))throw new Error('computer-use-production-claim-policy-duplicate');
    claims.add(item.claim);
    if(!safeInt(item.minPassingCases,1))throw new Error('computer-use-production-claim-threshold-invalid');
  }
  if(!Array.isArray(policy.requiredSourceKinds)||policy.requiredSourceKinds.length===0||policy.requiredSourceKinds.length>COMPUTER_USE_EVALUATION_SOURCE_KINDS.length)
    throw new Error('computer-use-production-source-policy-invalid');
  const sourceKinds=new Set<ComputerUseEvaluationSourceKind>();
  for(const sourceKind of policy.requiredSourceKinds){
    if(!COMPUTER_USE_EVALUATION_SOURCE_KINDS.includes(sourceKind)||sourceKinds.has(sourceKind))throw new Error('computer-use-production-source-policy-invalid');
    sourceKinds.add(sourceKind);
  }
}

function validateClaimEvidence(evidence:readonly ComputerUseProductionClaimEvidence[]):void {
  if(!Array.isArray(evidence)||evidence.length>COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS.length)throw new Error('computer-use-production-claim-evidence-invalid');
  const claims=new Set<ComputerUseProductionSafetyClaim>();
  for(const item of evidence){
    if(!item||typeof item!=='object'||!COMPUTER_USE_PRODUCTION_SAFETY_CLAIMS.includes(item.claim)||claims.has(item.claim))
      throw new Error('computer-use-production-claim-evidence-invalid');
    claims.add(item.claim);
    if(!Array.isArray(item.caseIds)||item.caseIds.length===0||item.caseIds.length>MAX_THRESHOLD||new Set(item.caseIds).size!==item.caseIds.length||item.caseIds.some((id:unknown)=>typeof id!=='string'||!TOKEN.test(id)))
      throw new Error('computer-use-production-claim-evidence-invalid');
  }
}

/**
 * Evaluate release eligibility against an explicitly supplied policy. This does
 * not grant computer-use authority, choose a CU level, or provide a default
 * production threshold. Missing policy/evidence is intentionally a blocker.
 */
export function evaluateComputerUseProductionGate(
  policy:ComputerUseProductionGatePolicy,
  cases:readonly ComputerUseEvaluationCaseResult[],
  claimEvidence:readonly ComputerUseProductionClaimEvidence[],
):ComputerUseProductionGateDecision {
  validateComputerUseProductionGatePolicy(policy);
  validateEmpiricalComputerUseEvaluationCases(cases);
  validateClaimEvidence(claimEvidence);
  const evaluation=summarizeComputerUseEvaluation(cases);
  const blockers:string[]=[];

  for(const requirement of policy.stratumRequirements){
    const summary=evaluation.strata.find((entry)=>entry.stratum===requirement.stratum)!;
    if(summary.attempted<requirement.minAttempted)blockers.push(`stratum:${requirement.stratum}:attempted-below-threshold`);
    if(summary.successRate<requirement.minSuccessRate)blockers.push(`stratum:${requirement.stratum}:success-rate-below-threshold`);
    if(summary.failed>requirement.maxFailed)blockers.push(`stratum:${requirement.stratum}:failures-above-threshold`);
    if(summary.unknown>requirement.maxUnknown)blockers.push(`stratum:${requirement.stratum}:unknown-above-threshold`);
  }

  const observedSourceKinds=new Set<ComputerUseEvaluationSourceKind>();
  for(const entry of cases)for(const source of entry.sources??[])observedSourceKinds.add(source.kind);
  for(const required of policy.requiredSourceKinds){
    if(!observedSourceKinds.has(required))blockers.push(`source-kind:${required}:missing`);
  }

  const byId=new Map(cases.map((entry)=>[entry.caseId,entry] as const));
  const evidenceByClaim=new Map(claimEvidence.map((entry)=>[entry.claim,entry] as const));
  const satisfiedClaims:ComputerUseProductionSafetyClaim[]=[];
  for(const requirement of policy.claimRequirements){
    const supplied=evidenceByClaim.get(requirement.claim);
    if(!supplied){
      blockers.push(`claim:${requirement.claim}:evidence-missing`);
      continue;
    }
    let passing=0;
    for(const caseId of supplied.caseIds){
      const entry=byId.get(caseId);
      if(!entry){
        blockers.push(`claim:${requirement.claim}:case-missing:${caseId}`);
        continue;
      }
      if(entry.outcome!=='passed'){
        blockers.push(`claim:${requirement.claim}:case-not-passed:${caseId}`);
        continue;
      }
      passing+=1;
    }
    if(passing<requirement.minPassingCases)blockers.push(`claim:${requirement.claim}:passing-cases-below-threshold`);
    else satisfiedClaims.push(requirement.claim);
  }

  return Object.freeze({
    eligible:blockers.length===0,
    authorityGranted:false as const,
    blockers:Object.freeze(blockers),
    evaluation,
    satisfiedSourceKinds:Object.freeze([...observedSourceKinds].sort()),
    satisfiedClaims:Object.freeze(satisfiedClaims),
  });
}
