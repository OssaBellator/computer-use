import type { WindowsUiaSemanticOfflineEvaluation } from './windowsUiaSemanticOfflineEvaluation.js';
import type { WindowsUiaSemanticRecipeRegistry } from './windowsUiaSemanticRecipeRegistry.js';

const TOKEN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const DIGEST=/^sha256:[a-f0-9]{64}$/;
const MAX_EVIDENCE=64;

export interface WindowsUiaSemanticPromotionCandidateRequest {
  readonly recipeId:string;
  readonly baseDigest:string;
  readonly proposedDigest:string;
  readonly corpusDigest:string;
  readonly evaluation:WindowsUiaSemanticOfflineEvaluation;
  /** Replay/review provenance only; never execution grants. */
  readonly evidenceIds:readonly string[];
}

export type WindowsUiaSemanticPromotionCandidate = Readonly<{
  status:'reviewable'|'blocked';
  recipeId:string;
  baseDigest:string;
  proposedDigest:string;
  corpusDigest:string;
  reasons:readonly string[];
  evidenceIds:readonly string[];
  /** Candidate creation cannot approve or activate a recipe. */
  promotionApproved:false;
  authorityGranted:false;
}>;

function validEvidence(values:readonly string[]):boolean {
  return Array.isArray(values)&&values.length>0&&values.length<=MAX_EVIDENCE&&
    values.every((value)=>typeof value==='string'&&TOKEN.test(value))&&new Set(values).size===values.length;
}

/**
 * Build a human-review candidate from exact immutable registry entries and an
 * offline replay result. This does not approve, activate, or dispatch anything.
 */
export function assessWindowsUiaSemanticPromotionCandidate(
  registry:WindowsUiaSemanticRecipeRegistry,
  request:WindowsUiaSemanticPromotionCandidateRequest,
):WindowsUiaSemanticPromotionCandidate {
  if(!registry||typeof registry!=='object'||!request||typeof request!=='object'||
    typeof request.recipeId!=='string'||!TOKEN.test(request.recipeId)||
    typeof request.baseDigest!=='string'||!DIGEST.test(request.baseDigest)||
    typeof request.proposedDigest!=='string'||!DIGEST.test(request.proposedDigest)||
    typeof request.corpusDigest!=='string'||!DIGEST.test(request.corpusDigest)||
    request.baseDigest===request.proposedDigest||!validEvidence(request.evidenceIds))
    throw new Error('windows-uia-semantic-promotion-candidate-invalid');
  if(!request.evaluation||typeof request.evaluation!=='object'||request.evaluation.authorityGranted!==false||request.evaluation.promotionEligible!==false||
    typeof request.evaluation.corpusDigest!=='string'||!DIGEST.test(request.evaluation.corpusDigest))
    throw new Error('windows-uia-semantic-promotion-evaluation-invalid');

  const reasons:string[]=[];
  const base=registry.resolveExact(request.recipeId,request.baseDigest);
  const proposed=registry.resolveExact(request.recipeId,request.proposedDigest);
  if(!base)reasons.push('base-manifest-not-registered');
  if(!proposed)reasons.push('proposed-manifest-not-registered');
  if(base&&proposed&& (proposed.parentDigest!==base.digest||proposed.revision!==base.revision+1))reasons.push('proposed-not-direct-child');
  if(request.corpusDigest!==request.evaluation.corpusDigest)reasons.push('offline-replay-corpus-mismatch');
  if(request.evaluation.regressions!==0||request.evaluation.status==='regressed')reasons.push('offline-replay-regression');
  if(request.evaluation.cases<=0)reasons.push('offline-replay-empty');

  return Object.freeze({
    status:reasons.length===0?'reviewable':'blocked',
    recipeId:request.recipeId,baseDigest:request.baseDigest,proposedDigest:request.proposedDigest,corpusDigest:request.corpusDigest,
    reasons:Object.freeze(reasons),evidenceIds:Object.freeze([...request.evidenceIds]),
    promotionApproved:false as const,authorityGranted:false as const,
  });
}
