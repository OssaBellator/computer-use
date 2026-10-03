import type { ComputerTaskContinuationDecision } from './computerTaskRuntime.js';
import {
  decideWindowsAuthenticationSessionAuthority,
  type WindowsAuthenticationSessionGrant,
  type WindowsAuthenticationSessionObservation,
} from './windowsAuthenticationSessionAuthority.js';

export interface WindowsAuthenticationContinuationSnapshot {
  readonly grant:WindowsAuthenticationSessionGrant;
  readonly observation:WindowsAuthenticationSessionObservation;
  readonly nowMs?:number;
}

export interface WindowsAuthenticationContinuationProvider {
  observe():Promise<WindowsAuthenticationContinuationSnapshot>;
}

/**
 * Long-horizon continuation gate for authenticated Windows work. It never authenticates,
 * refreshes, retries, or grants authority itself; it only decides whether the already-bound
 * task may continue under a fresh authoritative session observation.
 */
export function windowsAuthenticationTaskContinuationGate(
  provider:WindowsAuthenticationContinuationProvider,
):()=>Promise<ComputerTaskContinuationDecision>{
  return async()=>{
    let snapshot:WindowsAuthenticationContinuationSnapshot;
    try{snapshot=await provider.observe();}
    catch{return Object.freeze({state:'suspend',evidence:Object.freeze(['windows-auth-continuation-provider-unknown'])});}
    const decision=decideWindowsAuthenticationSessionAuthority(snapshot.grant,snapshot.observation,snapshot.nowMs??Date.now());
    if(decision.status==='authorized'){
      return Object.freeze({state:'continue',evidence:decision.evidence});
    }
    const reason=decision.status==='reauthentication-required'
      ? 'windows-auth-continuation-reauthentication-required'
      : decision.status==='reobserve-required'
        ? 'windows-auth-continuation-reobserve-required'
        : 'windows-auth-continuation-rejected';
    return Object.freeze({state:'suspend',evidence:Object.freeze([...decision.evidence,reason])});
  };
}
