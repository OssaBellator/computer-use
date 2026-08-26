import type { ComputerActionResult } from './environmentAdapter.js';

export interface WindowsAuthoritativeObservation<T> {
  /** Monotonic provider sequence for the authoritative observation channel. */
  readonly sequence:number;
  readonly capturedAtMs:number;
  readonly value:T;
}

export interface WindowsPostActionObservationProvider<T> {
  observe():Promise<WindowsAuthoritativeObservation<T>>;
}

export type WindowsVerificationPredicate<T> = (
  observation:WindowsAuthoritativeObservation<T>,
) => 'match'|'mismatch'|'inconclusive';

export interface WindowsPostActionVerificationOptions {
  readonly timeoutMs?:number;
  readonly pollIntervalMs?:number;
  readonly maxSamples?:number;
  readonly maxConsecutiveErrors?:number;
  readonly sleep?:(milliseconds:number)=>Promise<void>;
  readonly now?:()=>number;
}

const MAX_TIMEOUT_MS=10_000;
const MAX_SAMPLES=100;
const MAX_ERRORS=10;
const MAX_EVIDENCE=16;
const EVIDENCE_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,191}$/i;
const defaultSleep=(milliseconds:number)=>new Promise<void>(resolve=>setTimeout(resolve,milliseconds));

function boundedInt(value:number,min:number,max:number):boolean {
  return Number.isSafeInteger(value)&&value>=min&&value<=max;
}
function evidence(values:readonly string[]|undefined,extra:string):readonly string[]{
  const result:string[]=[];
  for(const item of values??[]){
    if(result.length>=MAX_EVIDENCE-1)break;
    if(typeof item==='string'&&EVIDENCE_PATTERN.test(item))result.push(item);
  }
  result.push(extra);
  return Object.freeze(result);
}
function withVerification(
  original:ComputerActionResult,
  verdict:'verified'|'mismatch'|'unverified',
  code:string,
):ComputerActionResult {
  // Dispatch uncertainty is sticky. Observation can classify the visible effect
  // but cannot prove how many native effects crossed an uncertain call boundary.
  if(original.dispatch==='unknown'||original.status==='unknown'){
    return Object.freeze({
      ...original,
      status:'unknown',
      dispatch:'unknown',
      verification:verdict,
      evidence:evidence(original.evidence,code),
    });
  }
  if(original.dispatch==='not-dispatched')return original;
  if(verdict==='verified'){
    return Object.freeze({...original,status:'completed',verification:'verified',evidence:evidence(original.evidence,code)});
  }
  if(verdict==='mismatch'){
    return Object.freeze({...original,status:'failed',verification:'mismatch',evidence:evidence(original.evidence,code)});
  }
  return Object.freeze({...original,verification:'unverified',evidence:evidence(original.evidence,code)});
}

/**
 * Bounded post-action verification over an authoritative Windows observation
 * source. Successful samples must advance monotonically; duplicate/regressed
 * sequence numbers are ignored as stale evidence. Missing evidence never becomes
 * success, and an UNKNOWN dispatch ledger remains UNKNOWN after reconciliation.
 */
export async function verifyWindowsPostAction<T>(
  original:ComputerActionResult,
  provider:WindowsPostActionObservationProvider<T>,
  predicate:WindowsVerificationPredicate<T>,
  options:WindowsPostActionVerificationOptions={},
):Promise<ComputerActionResult>{
  if(original.dispatch==='not-dispatched')return original;

  const timeoutMs=options.timeoutMs??750;
  const pollIntervalMs=options.pollIntervalMs??25;
  const maxSamples=options.maxSamples??32;
  const maxConsecutiveErrors=options.maxConsecutiveErrors??3;
  if(!boundedInt(timeoutMs,0,MAX_TIMEOUT_MS)||!boundedInt(pollIntervalMs,0,MAX_TIMEOUT_MS)||
     !boundedInt(maxSamples,1,MAX_SAMPLES)||!boundedInt(maxConsecutiveErrors,0,MAX_ERRORS)){
    throw new Error('windows-post-action-verification-options-invalid');
  }
  const now=options.now??Date.now;
  const sleep=options.sleep??defaultSleep;
  const started=now();
  let lastSequence=-1;
  let successfulSamples=0;
  let consecutiveErrors=0;

  while(successfulSamples<maxSamples){
    try{
      const observation=await provider.observe();
      if(!Number.isSafeInteger(observation.sequence)||observation.sequence<0||
         !Number.isSafeInteger(observation.capturedAtMs)||observation.capturedAtMs<0){
        throw new Error('windows-post-action-observation-invalid');
      }
      consecutiveErrors=0;
      if(observation.sequence>lastSequence){
        lastSequence=observation.sequence;
        successfulSamples+=1;
        const verdict=predicate(observation);
        if(verdict==='match')return withVerification(original,'verified','windows-post-action-verified');
        if(verdict==='mismatch')return withVerification(original,'mismatch','windows-post-action-mismatch');
        if(verdict!=='inconclusive')throw new Error('windows-post-action-verdict-invalid');
      }
    }catch{
      consecutiveErrors+=1;
      if(consecutiveErrors>maxConsecutiveErrors){
        return withVerification(original,'unverified','windows-post-action-observation-unavailable');
      }
    }

    const elapsed=Math.max(0,now()-started);
    if(elapsed>=timeoutMs||successfulSamples>=maxSamples)break;
    await sleep(Math.min(pollIntervalMs,Math.max(0,timeoutMs-elapsed)));
  }
  return withVerification(original,'unverified','windows-post-action-verification-inconclusive');
}
