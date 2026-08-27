import type { ComputerActionResult } from './environmentAdapter.js';
import { decideComputerConsequenceAuthority, type ComputerEffectAuthorityGrant } from './consequenceAuthority.js';
import { mayContributeInstructionAuthority, type ObservationTrust } from './observationTrust.js';
import {
  sameWindowsUiaControl,
  sameWindowsUiaWindow,
  type WindowsUiaControlRef,
  type WindowsUiaProvider,
} from './windowsUiaContract.js';
import { decideWindowsWindowAuthority, type WindowsWindowAuthoritySnapshot } from './windowsWindowAuthority.js';

const ID_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const PURPOSE_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MAX_EVIDENCE=16;
const MAX_CREDENTIAL_GRANT_TTL_MS=60_000;
const MAX_CONSUMED_GRANTS=1_024;
const EVIDENCE_PATTERN=/^[a-z0-9][a-z0-9._:-]{0,191}$/i;

/**
 * Trusted authority binding for one opaque credential and one exact password field.
 * `credentialRef` is a broker-owned identifier, never secret material.
 */
export interface WindowsCredentialGrant {
  readonly grantId:string;
  readonly credentialRef:string;
  readonly target:WindowsUiaControlRef;
  readonly purpose:string;
  /** Short-lived authority; the mediator also consumes each grantId at most once. */
  readonly expiresAtMs:number;
  readonly source:ObservationTrust;
}

export interface WindowsCredentialBrokerRequest {
  readonly credentialRef:string;
  readonly target:WindowsUiaControlRef;
  readonly purpose:string;
}

export type WindowsCredentialBrokerResult =
  | {readonly status:'applied';readonly evidence?:readonly string[]}
  | {readonly status:'rejected'|'unavailable'|'unknown';readonly evidence?:readonly string[]};

/**
 * Secret-owning boundary. Implementations may use an OS credential store, secure
 * enterprise broker, hardware-backed secret service, or trusted user gesture.
 * This interface intentionally has no read/export method and never returns bytes.
 */
export interface WindowsCredentialBroker {
  applyCredential(request:WindowsCredentialBrokerRequest):Promise<WindowsCredentialBrokerResult>;
}

export interface WindowsCredentialApplicationRequest {
  readonly target:WindowsUiaControlRef;
  /** Fresh top-level/modal authority snapshots for this interaction attempt. */
  readonly windows:readonly WindowsWindowAuthoritySnapshot[];
  readonly credentialGrant:WindowsCredentialGrant;
  readonly consequenceGrants?:readonly ComputerEffectAuthorityGrant[];
}

function evidence(values:readonly string[]|undefined,code:string):readonly string[]{
  const result:string[]=[];
  for(const item of values??[]){
    if(result.length>=MAX_EVIDENCE-1)break;
    if(typeof item==='string'&&EVIDENCE_PATTERN.test(item))result.push(item);
  }
  result.push(code);
  return Object.freeze(result);
}
function rejected(code:string):ComputerActionResult {
  return Object.freeze({status:'rejected',dispatch:'not-dispatched',verification:'unverified',evidence:Object.freeze([code])});
}
function validGrant(grant:WindowsCredentialGrant,now:number):boolean {
  return ID_PATTERN.test(grant.grantId)&&ID_PATTERN.test(grant.credentialRef)&&PURPOSE_PATTERN.test(grant.purpose)&&
    Number.isSafeInteger(grant.expiresAtMs)&&grant.expiresAtMs>=now&&grant.expiresAtMs<=now+MAX_CREDENTIAL_GRANT_TTL_MS&&
    mayContributeInstructionAuthority(grant.source);
}

/**
 * Applies an approved credential without exposing its contents to computer-use.
 *
 * Safety invariants:
 * - an original trusted authority source must bind the opaque credential ref;
 * - the grant is exact-control and generation bound;
 * - the target is revalidated immediately before the broker boundary;
 * - only a current UIA password control is eligible;
 * - password snapshots must already have redacted `value`;
 * - broker exceptions are sticky UNKNOWN because application may have occurred;
 * - no successful result claims semantic verification of the secret itself.
 */
export class WindowsCredentialMediator {
  private readonly consumedGrantIds=new Map<string,number>();
  constructor(
    readonly uia:WindowsUiaProvider,
    readonly broker:WindowsCredentialBroker,
    readonly now:()=>number=Date.now,
  ) {}

  async apply(request:WindowsCredentialApplicationRequest):Promise<ComputerActionResult>{
    const authority=decideComputerConsequenceAuthority('security-sensitive',request.consequenceGrants??[]);
    if(!authority.allowed)return rejected(`windows-credential-${authority.reason}`);
    const grant=request.credentialGrant;
    const now=this.now();
    for(const [grantId,expiresAtMs] of this.consumedGrantIds){
      if(expiresAtMs<now)this.consumedGrantIds.delete(grantId);
    }
    if(!validGrant(grant,now))return rejected('windows-credential-grant-invalid');
    if(this.consumedGrantIds.has(grant.grantId))return rejected('windows-credential-grant-consumed');
    if(this.consumedGrantIds.size>=MAX_CONSUMED_GRANTS)return rejected('windows-credential-grant-ledger-full');
    if(!sameWindowsUiaControl(grant.target,request.target))return rejected('windows-credential-grant-target-mismatch');

    const windowAuthority=decideWindowsWindowAuthority(request.target.window,request.windows);
    if(!windowAuthority.allowed)return rejected(`windows-credential-window-authority-${windowAuthority.reason}`);
    if(!sameWindowsUiaWindow(windowAuthority.target,request.target.window)){
      return rejected('windows-credential-window-authority-rerouted-reobserve');
    }

    const current=await this.uia.revalidateControl(request.target);
    if(current.status!=='current')return rejected(`windows-credential-target-${current.status}`);
    if(!sameWindowsUiaControl(current.control.ref,request.target))return rejected('windows-credential-target-replaced');
    if(current.control.isPassword!==true)return rejected('windows-credential-target-not-password');
    if(current.control.value!==undefined)return rejected('windows-credential-password-value-exposed');
    if(!current.control.enabled)return rejected('windows-credential-target-disabled');
    if(!current.control.patterns.includes('value'))return rejected('windows-credential-value-pattern-unavailable');

    // Consume before crossing the secret-owning boundary. UNKNOWN must never be
    // retried with the same credential authority.
    this.consumedGrantIds.set(grant.grantId,grant.expiresAtMs);
    try{
      const result=await this.broker.applyCredential(Object.freeze({
        credentialRef:grant.credentialRef,
        target:request.target,
        purpose:grant.purpose,
      }));
      if(result.status==='applied'){
        return Object.freeze({
          status:'completed',
          dispatch:'dispatched-once',
          verification:'unverified',
          evidence:evidence(result.evidence,'windows-credential-applied-secret-not-observed'),
        });
      }
      if(result.status==='unknown'){
        return Object.freeze({
          status:'unknown',dispatch:'unknown',verification:'unverified',
          evidence:evidence(result.evidence,'windows-credential-broker-unknown'),
        });
      }
      if(result.status==='rejected'||result.status==='unavailable'){
        return Object.freeze({
          status:result.status==='rejected'?'rejected':'unsupported',
          dispatch:'not-dispatched',
          verification:'unverified',
          evidence:evidence(result.evidence,`windows-credential-${result.status}`),
        });
      }
      return rejected('windows-credential-broker-result-invalid');
    }catch{
      return Object.freeze({
        status:'unknown',
        dispatch:'unknown',
        verification:'unverified',
        evidence:Object.freeze(['windows-credential-broker-unknown']),
      });
    }
  }
}
