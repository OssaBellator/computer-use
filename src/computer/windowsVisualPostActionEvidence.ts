import type { ComputerActionResult } from './environmentAdapter.js';

export interface WindowsVisualPostActionObservation<T> {
  readonly frameSequence:number;
  readonly capturedAtMs:number;
  readonly value:T;
}

export interface WindowsVisualPostActionEvidenceProvider<T> {
  observe():Promise<WindowsVisualPostActionObservation<T>>;
}

export type WindowsVisualEvidencePredicate<T>=(
  observation:WindowsVisualPostActionObservation<T>,
)=>'match'|'mismatch'|'inconclusive';

const MAX_EVIDENCE=16;
const EVIDENCE_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,191}$/i;

function appendEvidence(original:ComputerActionResult,code:string):ComputerActionResult {
  const values:string[]=[];
  for(const item of original.evidence??[]){
    if(values.length>=MAX_EVIDENCE-1)break;
    if(typeof item==='string'&&EVIDENCE_PATTERN.test(item))values.push(item);
  }
  values.push(code);
  return Object.freeze({...original,evidence:Object.freeze(values)});
}

/**
 * Adds frame-bound visual post-action evidence without granting pixels semantic
 * verification authority. Existing authoritative verification and sticky UNKNOWN
 * dispatch state are preserved verbatim.
 */
export async function assessWindowsVisualPostActionEvidence<T>(
  original:ComputerActionResult,
  provider:WindowsVisualPostActionEvidenceProvider<T>,
  predicate:WindowsVisualEvidencePredicate<T>,
  notBeforeMs:number,
):Promise<ComputerActionResult>{
  if(original.dispatch==='not-dispatched')return original;
  if(!Number.isSafeInteger(notBeforeMs)||notBeforeMs<0)throw new Error('windows-visual-post-action-options-invalid');
  try{
    const observation=await provider.observe();
    if(!Number.isSafeInteger(observation.frameSequence)||observation.frameSequence<0||
       !Number.isSafeInteger(observation.capturedAtMs)||observation.capturedAtMs<notBeforeMs){
      return appendEvidence(original,'windows-visual-post-action-stale');
    }
    const verdict=predicate(observation);
    if(verdict==='match')return appendEvidence(original,'windows-visual-post-action-consistent');
    if(verdict==='mismatch')return appendEvidence(original,'windows-visual-post-action-conflict');
    if(verdict==='inconclusive')return appendEvidence(original,'windows-visual-post-action-inconclusive');
    return appendEvidence(original,'windows-visual-post-action-invalid');
  }catch{
    return appendEvidence(original,'windows-visual-post-action-unavailable');
  }
}
