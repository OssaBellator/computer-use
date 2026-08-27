import type { ComputerActionResult } from './environmentAdapter.js';
import type { ComputerEffectAuthorityGrant } from './consequenceAuthority.js';
import type { WindowsCredentialApplicationRequest, WindowsCredentialMediator } from './windowsCredentialMediator.js';
import { verifyWindowsPostAction, type WindowsPostActionObservationProvider } from './windowsPostActionVerification.js';
import type { WindowsUiaControlRef } from './windowsUiaContract.js';

export type WindowsAuthenticationState =
  | 'unauthenticated'
  | 'credential-required'
  | 'factor-required'
  | 'user-presence-required'
  | 'submitting'
  | 'authenticated'
  | 'rejected'
  | 'unknown';

export interface WindowsAuthenticationObservation {
  readonly state:WindowsAuthenticationState;
  readonly sequence:number;
  readonly capturedAtMs:number;
  readonly evidence?:readonly string[];
}

export interface WindowsAuthenticationStateProvider extends WindowsPostActionObservationProvider<WindowsAuthenticationObservation> {}

export interface WindowsAuthenticationSubmitter {
  submit(target:WindowsUiaControlRef, grants?:readonly ComputerEffectAuthorityGrant[]):Promise<ComputerActionResult>;
}

export interface WindowsAuthenticationFactorBrokerRequest {
  readonly factorRef:string;
  readonly purpose:'authenticate'|'reauthenticate';
  readonly kind:'totp'|'passkey'|'windows-hello'|'push-approval'|'user-presence';
}

export type WindowsAuthenticationFactorBrokerResult =
  | {readonly status:'completed';readonly evidence?:readonly string[]}
  | {readonly status:'user-presence-required';readonly evidence?:readonly string[]}
  | {readonly status:'rejected'|'unavailable'|'unknown';readonly evidence?:readonly string[]};

/** Factor-owning boundary. There is intentionally no factor read/export method. */
export interface WindowsAuthenticationFactorBroker {
  performFactor(request:WindowsAuthenticationFactorBrokerRequest):Promise<WindowsAuthenticationFactorBrokerResult>;
}

export interface WindowsAuthenticationAttempt {
  readonly credential?:WindowsCredentialApplicationRequest;
  readonly submitTarget?:WindowsUiaControlRef;
  readonly factor?:WindowsAuthenticationFactorBrokerRequest;
  readonly consequenceGrants?:readonly ComputerEffectAuthorityGrant[];
  readonly minimumSequenceExclusive?:number;
  readonly notBeforeMs?:number;
}

export interface WindowsAuthenticationOutcome {
  readonly state:WindowsAuthenticationState;
  readonly result:ComputerActionResult;
  readonly evidence:readonly string[];
}

const EVIDENCE=/^[a-z0-9][a-z0-9._:-]{0,191}$/i;
const OPAQUE_REF=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MAX_EVIDENCE=16;
function mergeEvidence(...sources:(readonly string[]|undefined)[]):readonly string[]{
  const out:string[]=[];
  for(const source of sources)for(const item of source??[]){
    if(out.length>=MAX_EVIDENCE)break;
    if(EVIDENCE.test(item)&&!out.includes(item))out.push(item);
  }
  return Object.freeze(out);
}
function outcome(state:WindowsAuthenticationState,result:ComputerActionResult,...evidence:(readonly string[]|undefined)[]):WindowsAuthenticationOutcome{
  return Object.freeze({state,result,evidence:mergeEvidence(...evidence,result.evidence)});
}
function terminalResult(status:'completed'|'rejected'|'unsupported'|'unknown',dispatch:'not-dispatched'|'dispatched-once'|'unknown',code:string):ComputerActionResult{
  return Object.freeze({status,dispatch,verification:'unverified',evidence:Object.freeze([code])});
}

/**
 * Coordinates login without ever owning password/MFA/passkey material.
 * Credential and factor brokers remain separate secret-owning boundaries.
 * Authentication success is claimed only from a newer authoritative observation.
 */
export class WindowsAuthenticationOrchestrator {
  constructor(
    readonly credentials:WindowsCredentialMediator,
    readonly states:WindowsAuthenticationStateProvider,
    readonly submitter?:WindowsAuthenticationSubmitter,
    readonly factors?:WindowsAuthenticationFactorBroker,
  ) {}

  async authenticate(attempt:WindowsAuthenticationAttempt):Promise<WindowsAuthenticationOutcome>{
    let last:ComputerActionResult=terminalResult('completed','not-dispatched','windows-authentication-observation-only');

    if(attempt.credential){
      last=await this.credentials.apply(attempt.credential);
      if(last.status==='unknown')return outcome('unknown',last,['windows-authentication-credential-unknown']);
      if(last.dispatch==='not-dispatched'&&last.status!=='completed')return outcome('credential-required',last,['windows-authentication-credential-not-applied']);
    }

    if(attempt.factor){
      if(!OPAQUE_REF.test(attempt.factor.factorRef))return outcome('factor-required',terminalResult('rejected','not-dispatched','windows-authentication-factor-ref-invalid'));
      if(!this.factors)return outcome('factor-required',terminalResult('unsupported','not-dispatched','windows-authentication-factor-broker-unavailable'));
      let factor:WindowsAuthenticationFactorBrokerResult;
      try{factor=await this.factors.performFactor(attempt.factor);}
      catch{return outcome('unknown',terminalResult('unknown','unknown','windows-authentication-factor-boundary-unknown'));}
      if(factor.status==='user-presence-required'){
        return outcome('user-presence-required',terminalResult('completed','not-dispatched','windows-authentication-user-presence-required'),factor.evidence);
      }
      if(factor.status==='unknown')return outcome('unknown',terminalResult('unknown','unknown','windows-authentication-factor-unknown'),factor.evidence);
      if(factor.status==='rejected')return outcome('rejected',terminalResult('rejected','not-dispatched','windows-authentication-factor-rejected'),factor.evidence);
      if(factor.status==='unavailable')return outcome('factor-required',terminalResult('unsupported','not-dispatched','windows-authentication-factor-unavailable'),factor.evidence);
      last=Object.freeze({status:'completed',dispatch:'dispatched-once',verification:'unverified',evidence:mergeEvidence(factor.evidence,['windows-authentication-factor-completed'])});
    }

    if(attempt.submitTarget){
      if(!this.submitter)return outcome('submitting',terminalResult('unsupported','not-dispatched','windows-authentication-submitter-unavailable'));
      last=await this.submitter.submit(attempt.submitTarget,attempt.consequenceGrants);
      if(last.status==='unknown'||last.dispatch==='unknown')return outcome('unknown',last,['windows-authentication-submit-unknown']);
      if(last.dispatch==='not-dispatched')return outcome('submitting',last,['windows-authentication-submit-not-dispatched']);
    }

    const verified=await verifyWindowsPostAction(last,this.states,(sample)=>{
      if(sample.value.state==='authenticated')return 'match';
      if(sample.value.state==='rejected')return 'mismatch';
      return 'inconclusive';
    },{
      minimumSequenceExclusive:attempt.minimumSequenceExclusive,
      notBeforeMs:attempt.notBeforeMs,
    });
    if(verified.verification==='verified')return outcome('authenticated',verified,['windows-authentication-session-established']);
    if(verified.verification==='mismatch')return outcome('rejected',verified,['windows-authentication-authoritative-rejection']);
    if(verified.status==='unknown'||verified.dispatch==='unknown')return outcome('unknown',verified,['windows-authentication-verification-unknown']);

    try{
      const observed=await this.states.observe();
      if(observed.value.state==='factor-required')return outcome('factor-required',verified,observed.value.evidence,['windows-authentication-factor-required']);
      if(observed.value.state==='user-presence-required')return outcome('user-presence-required',verified,observed.value.evidence,['windows-authentication-user-presence-required']);
      if(observed.value.state==='credential-required')return outcome('credential-required',verified,observed.value.evidence,['windows-authentication-credential-required']);
    }catch{}
    return outcome('submitting',verified,['windows-authentication-outcome-inconclusive']);
  }
}
