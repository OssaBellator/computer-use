import { mayContributeInstructionAuthority, type ObservationTrust } from './observationTrust.js';
import type { WindowsUiaWindowRef } from './windowsUiaContract.js';

export interface WindowsAuthenticationSessionGrant {
  readonly sessionGrantId:string;
  readonly accountRef:string;
  readonly window:WindowsUiaWindowRef;
  readonly establishedAtMs:number;
  readonly expiresAtMs:number;
  readonly source:ObservationTrust;
}

export interface WindowsAuthenticationSessionObservation {
  readonly accountRef?:string;
  readonly window:WindowsUiaWindowRef;
  readonly authenticated:boolean;
  readonly reauthenticationRequired:boolean;
  readonly sequence:number;
  readonly capturedAtMs:number;
}

export type WindowsAuthenticationSessionDecision =
  | {readonly status:'authorized';readonly grant:WindowsAuthenticationSessionGrant;readonly evidence:readonly string[]}
  | {readonly status:'reauthentication-required'|'reobserve-required'|'rejected';readonly evidence:readonly string[]};

const OPAQUE_REF=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MAX_SESSION_TTL_MS=15*60*1000;

function sameWindow(a:WindowsUiaWindowRef,b:WindowsUiaWindowRef):boolean{
  return a.hwnd===b.hwnd&&
    a.desktopSessionId===b.desktopSessionId&&
    a.process.processId===b.process.processId&&
    a.process.startIdentity===b.process.startIdentity&&
    a.generation===b.generation;
}

/**
 * Makes authenticated-session authority explicit and short-lived. A previous
 * login never authorizes a different process/window generation or account, and
 * any authoritative re-authentication signal invalidates reuse immediately.
 */
export function decideWindowsAuthenticationSessionAuthority(
  grant:WindowsAuthenticationSessionGrant,
  observation:WindowsAuthenticationSessionObservation,
  nowMs:number=Date.now(),
):WindowsAuthenticationSessionDecision{
  if(!OPAQUE_REF.test(grant.sessionGrantId)||!OPAQUE_REF.test(grant.accountRef)){
    return Object.freeze({status:'rejected',evidence:Object.freeze(['windows-auth-session-grant-invalid'])});
  }
  if(!mayContributeInstructionAuthority(grant.source)){
    return Object.freeze({status:'rejected',evidence:Object.freeze(['windows-auth-session-source-untrusted'])});
  }
  if(!Number.isSafeInteger(grant.establishedAtMs)||!Number.isSafeInteger(grant.expiresAtMs)||
     grant.establishedAtMs<0||grant.expiresAtMs<=grant.establishedAtMs||
     grant.expiresAtMs-grant.establishedAtMs>MAX_SESSION_TTL_MS){
    return Object.freeze({status:'rejected',evidence:Object.freeze(['windows-auth-session-lifetime-invalid'])});
  }
  if(!Number.isSafeInteger(nowMs)||nowMs<grant.establishedAtMs||nowMs>=grant.expiresAtMs){
    return Object.freeze({status:'reauthentication-required',evidence:Object.freeze(['windows-auth-session-expired'])});
  }
  if(!Number.isSafeInteger(observation.sequence)||observation.sequence<0||
     !Number.isSafeInteger(observation.capturedAtMs)||observation.capturedAtMs<grant.establishedAtMs||observation.capturedAtMs>nowMs){
    return Object.freeze({status:'reobserve-required',evidence:Object.freeze(['windows-auth-session-observation-stale'])});
  }
  if(!sameWindow(grant.window,observation.window)){
    return Object.freeze({status:'reobserve-required',evidence:Object.freeze(['windows-auth-session-window-generation-changed'])});
  }
  if(observation.reauthenticationRequired){
    return Object.freeze({status:'reauthentication-required',evidence:Object.freeze(['windows-auth-session-reauthentication-signaled'])});
  }
  if(!observation.authenticated){
    return Object.freeze({status:'reauthentication-required',evidence:Object.freeze(['windows-auth-session-not-authenticated'])});
  }
  if(!observation.accountRef||observation.accountRef!==grant.accountRef){
    return Object.freeze({status:'reobserve-required',evidence:Object.freeze(['windows-auth-session-account-changed'])});
  }
  return Object.freeze({status:'authorized',grant,evidence:Object.freeze(['windows-auth-session-authorized'])});
}

export function windowsAuthenticationSessionMaxTtlMs():number{return MAX_SESSION_TTL_MS;}
