import {
  digestWindowsUiaSemanticRecipeManifest,
  validateWindowsUiaSemanticRecipeRevision,
  type WindowsUiaSemanticRecipeManifest,
} from './windowsUiaSemanticRecipeManifest.js';

const TOKEN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const DIGEST=/^sha256:[0-9a-f]{64}$/;
const MAX_EVIDENCE=128;

export const WINDOWS_UIA_SEMANTIC_CORRECTION_TRIGGERS=[
  'grounding-missing',
  'grounding-ambiguous',
  'input-invalid',
  'provider-unavailable',
  'verification-mismatch',
] as const;
export type WindowsUiaSemanticCorrectionTrigger=typeof WINDOWS_UIA_SEMANTIC_CORRECTION_TRIGGERS[number];

export interface WindowsUiaSemanticCorrectionEpisode {
  readonly episodeId:string;
  readonly recipeId:string;
  readonly baseManifestDigest:string;
  readonly trigger:WindowsUiaSemanticCorrectionTrigger;
  /** Replay-identifiable observations, failures, demonstrations or review artifacts. */
  readonly evidenceIds:readonly string[];
  /** Candidate revision only. The episode cannot activate or dispatch it. */
  readonly proposedManifest:WindowsUiaSemanticRecipeManifest;
}

export type WindowsUiaSemanticCorrectionAssessment=
  | Readonly<{status:'reviewable';episodeId:string;proposedManifestDigest:string;authorityGranted:false;evidence:readonly string[]}>
  | Readonly<{status:'rejected';episodeId:string;reason:string;authorityGranted:false;evidence:readonly string[]}>;

function validEvidence(values:unknown):values is readonly string[]{
  return Array.isArray(values)&&values.length>0&&values.length<=MAX_EVIDENCE&&
    values.every((value)=>typeof value==='string'&&TOKEN.test(value))&&new Set(values).size===values.length;
}

/**
 * Validate one correction proposal against an exact prior recipe revision.
 * This is an offline learning/review primitive only: success means the proposal
 * is structurally reviewable. It never activates the revision, grants authority,
 * chooses an effect class, or dispatches an action.
 */
export function assessWindowsUiaSemanticCorrectionEpisode(
  previous:WindowsUiaSemanticRecipeManifest,
  episode:WindowsUiaSemanticCorrectionEpisode,
):WindowsUiaSemanticCorrectionAssessment {
  const episodeId=episode&&typeof episode==='object'&&typeof episode.episodeId==='string'&&TOKEN.test(episode.episodeId)
    ?episode.episodeId:'invalid';
  const reject=(reason:string)=>Object.freeze({
    status:'rejected' as const,episodeId,reason,authorityGranted:false as const,
    evidence:Object.freeze([`windows-uia-semantic-correction-${reason}`]),
  });
  if(episodeId==='invalid'||!TOKEN.test(episode.recipeId))return reject('identity-invalid');
  if(!DIGEST.test(episode.baseManifestDigest))return reject('base-digest-invalid');
  if(!WINDOWS_UIA_SEMANTIC_CORRECTION_TRIGGERS.includes(episode.trigger))return reject('trigger-invalid');
  if(!validEvidence(episode.evidenceIds))return reject('evidence-invalid');
  let previousDigest:string;
  try{previousDigest=digestWindowsUiaSemanticRecipeManifest(previous);}catch{return reject('base-manifest-invalid');}
  if(episode.baseManifestDigest!==previousDigest)return reject('base-digest-mismatch');
  if(previous.recipe.id!==episode.recipeId||episode.proposedManifest?.recipe?.id!==episode.recipeId)return reject('recipe-id-mismatch');
  try{validateWindowsUiaSemanticRecipeRevision(previous,episode.proposedManifest);}catch{return reject('revision-invalid');}
  const proposedEvidence=new Set(episode.proposedManifest.evidenceIds);
  if(episode.evidenceIds.some((id)=>!proposedEvidence.has(id)))return reject('evidence-not-bound-to-revision');
  const proposedManifestDigest=digestWindowsUiaSemanticRecipeManifest(episode.proposedManifest);
  return Object.freeze({
    status:'reviewable' as const,episodeId,proposedManifestDigest,authorityGranted:false as const,
    evidence:Object.freeze([
      `windows-uia-semantic-correction-${episode.trigger}`,
      'windows-uia-semantic-correction-offline-review-only',
      'windows-uia-semantic-correction-no-authority',
    ]),
  });
}
