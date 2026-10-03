import type { ComputerEntityRef } from './environmentAdapter.js';
import type { GroundingCandidate } from './groundingResolver.js';
import type { WindowsUiaActionSupportAssessment } from './windowsUiaContract.js';

export interface WindowsUiaSemanticGroundingCandidateInput {
  readonly id:string;
  readonly confidence:number;
  /** Neutral exact entity identity already established by the semantic grounding layer. */
  readonly target:ComputerEntityRef;
  /** Read-only exact-target support result produced immediately from fresh UIA revalidation. */
  readonly support:WindowsUiaActionSupportAssessment;
}

const STALE_EVIDENCE = new Set([
  'windows-uia-stale',
  'windows-uia-control-replaced',
]);

/**
 * Translates Windows' target-local UIA support assessment into the neutral
 * embodiment router without granting any new action authority. The assessment is
 * suitability evidence only; dispatch still performs the provider-boundary
 * generation/identity revalidation required by WindowsUiaProviderRuntime.
 */
export function windowsUiaSemanticGroundingCandidate(
  input:WindowsUiaSemanticGroundingCandidateInput,
):GroundingCandidate {
  const evidence=Object.freeze([...input.support.evidence]);
  const stale=input.support.status==='rejected'&&evidence.some((code)=>STALE_EVIDENCE.has(code));
  const supported=input.support.status==='supported';
  return Object.freeze({
    id:input.id,
    kind:'semantic-ui',
    confidence:input.confidence,
    target:input.target,
    supported,
    ...(supported?{}:{supportReason:evidence[0]??`windows-uia-support-${input.support.status}`}),
    stale,
    evidence,
  });
}
