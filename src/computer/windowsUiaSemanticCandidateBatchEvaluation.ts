import { evaluateWindowsUiaSemanticRecipeOffline, type WindowsUiaSemanticOfflineEvaluation, type WindowsUiaSemanticOfflineReplayCase } from './windowsUiaSemanticOfflineEvaluation.js';
import { digestWindowsUiaSemanticRecipeManifest, type WindowsUiaSemanticRecipeManifest } from './windowsUiaSemanticRecipeManifest.js';

const MAX_CANDIDATES=16;

export interface WindowsUiaSemanticCandidateBatchEntry {
  readonly proposedDigest:string;
  readonly evaluation:WindowsUiaSemanticOfflineEvaluation;
}

export interface WindowsUiaSemanticCandidateBatchEvaluation {
  readonly baseDigest:string;
  readonly corpusDigest:string;
  readonly candidateCount:number;
  readonly candidates:readonly WindowsUiaSemanticCandidateBatchEntry[];
  /** Batch comparison never chooses or activates a candidate. */
  readonly comparisonOnly:true;
  readonly selectionMade:false;
  readonly promotionApproved:false;
  readonly authorityGranted:false;
}

/**
 * Evaluate multiple immutable direct-child candidates against the same exact
 * replay corpus. Results are normalized by proposed manifest digest for stable
 * comparison only. This API deliberately performs no ranking, selection,
 * promotion, activation, authority grant, or dispatch.
 */
export function evaluateWindowsUiaSemanticCandidateBatch(
  base:WindowsUiaSemanticRecipeManifest,
  candidates:readonly WindowsUiaSemanticRecipeManifest[],
  cases:readonly WindowsUiaSemanticOfflineReplayCase[],
):WindowsUiaSemanticCandidateBatchEvaluation {
  if(!Array.isArray(candidates)||candidates.length===0||candidates.length>MAX_CANDIDATES)
    throw new Error('windows-uia-semantic-candidate-batch-invalid');
  const baseDigest=digestWindowsUiaSemanticRecipeManifest(base);
  const seen=new Set<string>();
  const results:WindowsUiaSemanticCandidateBatchEntry[]=[];
  let corpusDigest:string|undefined;
  for(const candidate of candidates){
    const proposedDigest=digestWindowsUiaSemanticRecipeManifest(candidate);
    if(seen.has(proposedDigest))throw new Error('windows-uia-semantic-candidate-batch-duplicate');
    seen.add(proposedDigest);
    const evaluation=evaluateWindowsUiaSemanticRecipeOffline(base,candidate,cases);
    if(corpusDigest===undefined)corpusDigest=evaluation.corpusDigest;
    else if(corpusDigest!==evaluation.corpusDigest)throw new Error('windows-uia-semantic-candidate-batch-corpus-mismatch');
    results.push(Object.freeze({proposedDigest,evaluation}));
  }
  results.sort((a,b)=>a.proposedDigest.localeCompare(b.proposedDigest));
  return Object.freeze({
    baseDigest,corpusDigest:corpusDigest!,candidateCount:results.length,candidates:Object.freeze(results),
    comparisonOnly:true as const,selectionMade:false as const,promotionApproved:false as const,authorityGranted:false as const,
  });
}
