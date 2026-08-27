import type { ComputerUseEvaluationCaseResult } from './computerUseEvaluation.js';
import {
  assessWindowsUiaSemanticCorrectionEpisode,
  type WindowsUiaSemanticCorrectionEpisode,
} from './windowsUiaSemanticCorrectionEpisode.js';
import {
  assessWindowsUiaSemanticCorrectionEvidence,
  type WindowsUiaSemanticCorrectionEvidenceBinding,
} from './windowsUiaSemanticCorrectionEvidence.js';
import type { WindowsUiaSemanticRecipeManifest } from './windowsUiaSemanticRecipeManifest.js';

export type WindowsUiaSemanticBoundCorrectionReview=
  | Readonly<{
      status:'reviewable';
      episodeId:string;
      proposedManifestDigest:string;
      evidenceBindings:readonly WindowsUiaSemanticCorrectionEvidenceBinding[];
      promotionApproved:false;
      authorityGranted:false;
    }>
  | Readonly<{
      status:'rejected';
      episodeId:string;
      reason:string;
      evidenceBindings:readonly WindowsUiaSemanticCorrectionEvidenceBinding[];
      promotionApproved:false;
      authorityGranted:false;
    }>;

/**
 * Compose immutable correction-lineage validation with empirical source binding.
 * Reviewable means only that the offline proposal and its provenance are coherent;
 * it never promotes, activates, grants authority, or dispatches the proposed recipe.
 */
export function assessWindowsUiaSemanticBoundCorrectionReview(
  cases:readonly ComputerUseEvaluationCaseResult[],
  previous:WindowsUiaSemanticRecipeManifest,
  episode:WindowsUiaSemanticCorrectionEpisode,
):WindowsUiaSemanticBoundCorrectionReview {
  const structural=assessWindowsUiaSemanticCorrectionEpisode(previous,episode);
  if(structural.status==='rejected'){
    return Object.freeze({
      status:'rejected' as const,episodeId:structural.episodeId,reason:`episode:${structural.reason}`,
      evidenceBindings:Object.freeze([]),promotionApproved:false as const,authorityGranted:false as const,
    });
  }
  const provenance=assessWindowsUiaSemanticCorrectionEvidence(cases,episode.evidenceIds);
  if(provenance.status==='rejected'){
    return Object.freeze({
      status:'rejected' as const,episodeId:structural.episodeId,reason:`evidence:${provenance.reason}`,
      evidenceBindings:provenance.bindings,promotionApproved:false as const,authorityGranted:false as const,
    });
  }
  return Object.freeze({
    status:'reviewable' as const,episodeId:structural.episodeId,proposedManifestDigest:structural.proposedManifestDigest,
    evidenceBindings:provenance.bindings,promotionApproved:false as const,authorityGranted:false as const,
  });
}
