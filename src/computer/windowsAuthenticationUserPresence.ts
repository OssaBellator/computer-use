import { mayContributeInstructionAuthority, type ObservationTrust } from './observationTrust.js';
import type { WindowsAuthenticationFactorKind, WindowsAuthenticationPurpose } from './windowsAuthenticationFactorMediator.js';

export type WindowsUserPresenceFactorKind=Exclude<WindowsAuthenticationFactorKind,'totp'>;
export type WindowsAuthenticationUserPresenceState='pending'|'completed'|'rejected'|'unknown';

export interface WindowsAuthenticationUserPresenceChallenge {
  readonly challengeRef:string;
  readonly factorRef:string;
  readonly kind:WindowsUserPresenceFactorKind;
  readonly purpose:WindowsAuthenticationPurpose;
  readonly issuedAtMs:number;
  readonly expiresAtMs:number;
  /** Original user/host authority that permits this exact presence ceremony. */
  readonly source:ObservationTrust;
}

export interface WindowsAuthenticationUserPresenceObservation {
  readonly challengeRef:string;
  readonly state:WindowsAuthenticationUserPresenceState;
  readonly sequence:number;
  readonly capturedAtMs:number;
  /** Trusted OS/application observation. This evidence does not itself create instruction authority. */
  readonly source:ObservationTrust;
}

export type WindowsAuthenticationUserPresenceDecision=
  | {readonly status:'completed';readonly evidence:readonly string[]}
  | {readonly status:'user-presence-required';readonly evidence:readonly string[]}
  | {readonly status:'rejected'|'unknown';readonly evidence:readonly string[]};

const REF=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MAX_CHALLENGE_TTL_MS=5*60*1000;
const USER_PRESENCE_KINDS:readonly WindowsUserPresenceFactorKind[]=['passkey','windows-hello','push-approval','user-presence'];

function trustedPresenceObservation(source:ObservationTrust):boolean{
  return !source.containsExternalUntrustedContent&&
    (source.classification==='trusted-application-state'||source.classification==='host-policy'||source.classification==='user-authored');
}

/**
 * Validates a user-presence ceremony without exposing biometric/passkey material.
 * Ceremony completion is evidence only; callers must still verify authenticated session state separately.
 */
export function decideWindowsAuthenticationUserPresence(
  challenge:WindowsAuthenticationUserPresenceChallenge,
  observation:WindowsAuthenticationUserPresenceObservation,
  nowMs:number=Date.now(),
):WindowsAuthenticationUserPresenceDecision{
  if(!REF.test(challenge.challengeRef)||!REF.test(challenge.factorRef)||!USER_PRESENCE_KINDS.includes(challenge.kind)){
    return Object.freeze({status:'rejected',evidence:Object.freeze(['windows-auth-presence-challenge-invalid'])});
  }
  if(!mayContributeInstructionAuthority(challenge.source)){
    return Object.freeze({status:'rejected',evidence:Object.freeze(['windows-auth-presence-source-untrusted'])});
  }
  if(!Number.isSafeInteger(challenge.issuedAtMs)||!Number.isSafeInteger(challenge.expiresAtMs)||challenge.issuedAtMs<0||
     challenge.expiresAtMs<=challenge.issuedAtMs||challenge.expiresAtMs-challenge.issuedAtMs>MAX_CHALLENGE_TTL_MS){
    return Object.freeze({status:'rejected',evidence:Object.freeze(['windows-auth-presence-lifetime-invalid'])});
  }
  if(!Number.isSafeInteger(nowMs)||nowMs<challenge.issuedAtMs||nowMs>=challenge.expiresAtMs){
    return Object.freeze({status:'user-presence-required',evidence:Object.freeze(['windows-auth-presence-challenge-expired'])});
  }
  if(!REF.test(observation.challengeRef)||observation.challengeRef!==challenge.challengeRef||
     !Number.isSafeInteger(observation.sequence)||observation.sequence<0||
     !Number.isSafeInteger(observation.capturedAtMs)||observation.capturedAtMs<challenge.issuedAtMs||observation.capturedAtMs>nowMs){
    return Object.freeze({status:'unknown',evidence:Object.freeze(['windows-auth-presence-observation-invalid'])});
  }
  if(!trustedPresenceObservation(observation.source)){
    return Object.freeze({status:'unknown',evidence:Object.freeze(['windows-auth-presence-observation-untrusted'])});
  }
  if(observation.state==='pending')return Object.freeze({status:'user-presence-required',evidence:Object.freeze(['windows-auth-presence-pending'])});
  if(observation.state==='completed')return Object.freeze({status:'completed',evidence:Object.freeze(['windows-auth-presence-completed'])});
  if(observation.state==='rejected')return Object.freeze({status:'rejected',evidence:Object.freeze(['windows-auth-presence-rejected'])});
  return Object.freeze({status:'unknown',evidence:Object.freeze(['windows-auth-presence-unknown'])});
}

export function windowsAuthenticationUserPresenceMaxTtlMs():number{return MAX_CHALLENGE_TTL_MS;}
