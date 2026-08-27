import { decideComputerConsequenceAuthority, type ComputerEffectAuthorityGrant } from './consequenceAuthority.js';
import { mayContributeInstructionAuthority, type ObservationTrust } from './observationTrust.js';

export type WindowsAuthenticationFactorKind='totp'|'passkey'|'windows-hello'|'push-approval'|'user-presence';
export type WindowsAuthenticationPurpose='authenticate'|'reauthenticate';

export interface WindowsAuthenticationFactorGrant {
  readonly grantId:string;
  readonly factorRef:string;
  readonly purpose:WindowsAuthenticationPurpose;
  readonly kind:WindowsAuthenticationFactorKind;
  readonly expiresAtMs:number;
  readonly source:ObservationTrust;
}

export interface WindowsAuthenticationFactorBrokerRequest {
  readonly factorRef:string;
  readonly purpose:WindowsAuthenticationPurpose;
  readonly kind:WindowsAuthenticationFactorKind;
}

export type WindowsAuthenticationFactorBrokerResult =
  | {readonly status:'completed';readonly evidence?:readonly string[]}
  | {readonly status:'user-presence-required';readonly evidence?:readonly string[]}
  | {readonly status:'rejected'|'unavailable'|'unknown';readonly evidence?:readonly string[]};

/** Secret/factor-owning boundary. There is intentionally no read/export operation. */
export interface WindowsAuthenticationFactorBroker {
  performFactor(request:WindowsAuthenticationFactorBrokerRequest):Promise<WindowsAuthenticationFactorBrokerResult>;
}

export interface WindowsAuthenticationFactorApplicationRequest extends WindowsAuthenticationFactorBrokerRequest {
  readonly factorGrant:WindowsAuthenticationFactorGrant;
  readonly consequenceGrants?:readonly ComputerEffectAuthorityGrant[];
}

const REF=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const EVIDENCE=/^[a-z0-9][a-z0-9._:-]{0,191}$/i;
const FACTOR_STATUSES=new Set(['completed','user-presence-required','rejected','unavailable','unknown']);
const MAX_GRANT_TTL_MS=60_000;
const MAX_CONSUMED=1024;
const MAX_EVIDENCE=16;

function normalizeBrokerResult(value:unknown,factorRef:string):WindowsAuthenticationFactorBrokerResult{
  if(!value||typeof value!=='object'||Array.isArray(value))return Object.freeze({status:'unknown',evidence:Object.freeze(['windows-auth-factor-broker-response-invalid'])});
  const record=value as Record<string,unknown>;
  if(Object.keys(record).some(key=>key!=='status'&&key!=='evidence'))return Object.freeze({status:'unknown',evidence:Object.freeze(['windows-auth-factor-broker-response-invalid'])});
  if(typeof record.status!=='string'||!FACTOR_STATUSES.has(record.status))return Object.freeze({status:'unknown',evidence:Object.freeze(['windows-auth-factor-broker-response-invalid'])});
  if(record.evidence!==undefined&&!Array.isArray(record.evidence))return Object.freeze({status:'unknown',evidence:Object.freeze(['windows-auth-factor-broker-response-invalid'])});
  const evidence:string[]=[];
  for(const item of (record.evidence as unknown[]|undefined)??[]){
    if(evidence.length>=MAX_EVIDENCE||typeof item!=='string'||!EVIDENCE.test(item)||item.includes(factorRef))return Object.freeze({status:'unknown',evidence:Object.freeze(['windows-auth-factor-broker-response-invalid'])});
    if(!evidence.includes(item))evidence.push(item);
  }
  return Object.freeze({status:record.status as WindowsAuthenticationFactorBrokerResult['status'],...(evidence.length?{evidence:Object.freeze(evidence)}:{})}) as WindowsAuthenticationFactorBrokerResult;
}

export class WindowsAuthenticationFactorMediator {
  private readonly consumed=new Set<string>();
  constructor(readonly broker:WindowsAuthenticationFactorBroker,readonly now:()=>number=Date.now){}

  async performFactor(request:WindowsAuthenticationFactorApplicationRequest):Promise<WindowsAuthenticationFactorBrokerResult>{
    const grant=request.factorGrant;
    const now=this.now();
    if(!REF.test(request.factorRef)||!REF.test(grant.grantId)||!REF.test(grant.factorRef))return Object.freeze({status:'rejected',evidence:Object.freeze(['windows-auth-factor-ref-invalid'])});
    if(grant.factorRef!==request.factorRef||grant.kind!==request.kind||grant.purpose!==request.purpose)return Object.freeze({status:'rejected',evidence:Object.freeze(['windows-auth-factor-grant-mismatch'])});
    if(!mayContributeInstructionAuthority(grant.source))return Object.freeze({status:'rejected',evidence:Object.freeze(['windows-auth-factor-source-untrusted'])});
    if(!Number.isSafeInteger(grant.expiresAtMs)||grant.expiresAtMs<=now||grant.expiresAtMs-now>MAX_GRANT_TTL_MS)return Object.freeze({status:'rejected',evidence:Object.freeze(['windows-auth-factor-grant-expired-or-unbounded'])});
    const consequence=decideComputerConsequenceAuthority('security-sensitive',request.consequenceGrants??[]);
    if(!consequence.allowed)return Object.freeze({status:'rejected',evidence:Object.freeze([`windows-auth-factor-${consequence.reason}`])});
    if(this.consumed.has(grant.grantId))return Object.freeze({status:'rejected',evidence:Object.freeze(['windows-auth-factor-grant-consumed'])});

    // Consume before crossing the broker boundary. A lost/ambiguous call must not
    // become retry-safe and accidentally perform a factor twice.
    this.consumed.add(grant.grantId);
    while(this.consumed.size>MAX_CONSUMED){
      const oldest=this.consumed.values().next().value as string|undefined;
      if(oldest===undefined)break;
      this.consumed.delete(oldest);
    }
    try{
      const result=await this.broker.performFactor(Object.freeze({factorRef:request.factorRef,purpose:request.purpose,kind:request.kind}));
      return normalizeBrokerResult(result,request.factorRef);
    }catch{
      return Object.freeze({status:'unknown',evidence:Object.freeze(['windows-auth-factor-broker-unknown'])});
    }
  }
}

export function windowsAuthenticationFactorGrantMaxTtlMs():number{return MAX_GRANT_TTL_MS;}
