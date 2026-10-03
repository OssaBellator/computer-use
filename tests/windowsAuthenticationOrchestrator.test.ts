import test from 'node:test';
import assert from 'node:assert/strict';
import { observationTrust } from '../src/computer/observationTrust.js';
import { WindowsAuthenticationOrchestrator, type WindowsAuthenticationStateProvider } from '../src/computer/windowsAuthenticationOrchestrator.js';
import { WindowsCredentialMediator, type WindowsCredentialBroker } from '../src/computer/windowsCredentialMediator.js';
import type { WindowsUiaControlRef, WindowsUiaProvider } from '../src/computer/windowsUiaContract.js';

const windowRef=Object.freeze({hwnd:'0xaaa',desktopSessionId:'session:1',process:Object.freeze({processId:40,startIdentity:'p40'}),generation:1});
const password:WindowsUiaControlRef=Object.freeze({window:windowRef,runtimeId:Object.freeze([1]),automationId:'Password',controlType:'Edit',generation:1});
const submit:WindowsUiaControlRef=Object.freeze({window:windowRef,runtimeId:Object.freeze([2]),automationId:'Login',controlType:'Button',generation:1});
const trusted=observationTrust('user-authored',['auth']);
const windows=Object.freeze([{window:windowRef,isModal:false,interactionState:'ready-for-user-interaction' as const}]);
const credentialGrant=Object.freeze({grantId:'cred-1',credentialRef:'vault:login',target:password,purpose:'authenticate',expiresAtMs:10_500,source:trusted});
const consequence=Object.freeze({grantId:'security-1',source:trusted,allowedEffects:Object.freeze(['security-sensitive' as const])});

function uia():WindowsUiaProvider{return{
  observeCached:async()=>{throw new Error('not-used');},
  revalidateControl:async()=>({status:'current',control:{ref:password,name:'Password',enabled:true,isPassword:true,patterns:['value']}}),
  performSemanticAction:async()=>{throw new Error('not-used');},
};}
function credentialMediator(result:Awaited<ReturnType<WindowsCredentialBroker['applyCredential']>>={status:'applied'}){
  const broker:WindowsCredentialBroker={applyCredential:async()=>result};
  return new WindowsCredentialMediator(uia(),broker,()=>10_000);
}
function states(values:readonly ('authenticated'|'rejected'|'factor-required'|'user-presence-required'|'submitting')[]):WindowsAuthenticationStateProvider{
  let index=0;
  return {observe:async()=>{
    const state=values[Math.min(index++,values.length-1)]??'submitting';
    return {sequence:index,capturedAtMs:10_100+index,value:{state,sequence:index,capturedAtMs:10_100+index,evidence:[`state-${state}`]}};
  }};
}
const credentialRequest={target:password,windows,credentialGrant,consequenceGrants:[consequence]};

test('authentication success requires newer authoritative authenticated observation',async()=>{
  const orchestrator=new WindowsAuthenticationOrchestrator(
    credentialMediator(),states(['authenticated']),
    {submit:async()=>({status:'completed',dispatch:'dispatched-once',verification:'unverified',evidence:['submit-dispatched']})},
  );
  const out=await orchestrator.authenticate({credential:credentialRequest,submitTarget:submit,consequenceGrants:[consequence],minimumSequenceExclusive:0,notBeforeMs:10_000});
  assert.equal(out.state,'authenticated');
  assert.equal(out.result.verification,'verified');
  assert.ok(out.evidence.includes('windows-authentication-session-established'));
});

test('authoritative rejection is not converted into retry-safe success',async()=>{
  const orchestrator=new WindowsAuthenticationOrchestrator(
    credentialMediator(),states(['rejected']),
    {submit:async()=>({status:'completed',dispatch:'dispatched-once',verification:'unverified'})},
  );
  const out=await orchestrator.authenticate({credential:credentialRequest,submitTarget:submit,consequenceGrants:[consequence]});
  assert.equal(out.state,'rejected');
  assert.equal(out.result.verification,'mismatch');
});

test('ambiguous submit stays sticky UNKNOWN and skips success verification',async()=>{
  let observations=0;
  const stateProvider:WindowsAuthenticationStateProvider={observe:async()=>{observations+=1;return {sequence:1,capturedAtMs:1,value:{state:'authenticated',sequence:1,capturedAtMs:1}};}};
  const orchestrator=new WindowsAuthenticationOrchestrator(
    credentialMediator(),stateProvider,
    {submit:async()=>({status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['submit-boundary-lost']})},
  );
  const out=await orchestrator.authenticate({credential:credentialRequest,submitTarget:submit,consequenceGrants:[consequence]});
  assert.equal(out.state,'unknown');
  assert.equal(out.result.dispatch,'unknown');
  assert.equal(observations,0);
});

test('factor broker never returns factor material and user-presence is a first-class state',async()=>{
  let request:unknown;
  const orchestrator=new WindowsAuthenticationOrchestrator(
    credentialMediator(),states(['submitting']),undefined,
    {performFactor:async value=>{request=value;return {status:'user-presence-required',evidence:['touch-security-key']};}},
  );
  const factor={factorRef:'factor:passkey:work',purpose:'authenticate' as const,kind:'passkey' as const,factorGrant:{grantId:'factor-grant:passkey',factorRef:'factor:passkey:work',purpose:'authenticate' as const,kind:'passkey' as const,expiresAtMs:10_500,source:trusted},consequenceGrants:[consequence]};
  const out=await orchestrator.authenticate({factor});
  assert.deepEqual(request,factor);
  assert.equal(out.state,'user-presence-required');
  assert.equal(JSON.stringify(out).includes('secret'),false);
});

test('factor boundary exception is sticky UNKNOWN rather than a retryable failure',async()=>{
  const orchestrator=new WindowsAuthenticationOrchestrator(
    credentialMediator(),states(['authenticated']),undefined,
    {performFactor:async()=>{throw new Error('boundary-lost');}},
  );
  const out=await orchestrator.authenticate({factor:{factorRef:'factor:hello',purpose:'reauthenticate',kind:'windows-hello',factorGrant:{grantId:'factor-grant:hello',factorRef:'factor:hello',purpose:'reauthenticate',kind:'windows-hello',expiresAtMs:10_500,source:trusted},consequenceGrants:[consequence]}});
  assert.equal(out.state,'unknown');
  assert.equal(out.result.dispatch,'unknown');
});

test('factor references are never echoed in authentication outcome evidence',async()=>{
  const orchestrator=new WindowsAuthenticationOrchestrator(
    credentialMediator(),states(['authenticated']),undefined,
    {performFactor:async()=>({status:'completed'})},
  );
  const ref='factor:private-account-alias';
  const completed=await orchestrator.authenticate({factor:{factorRef:ref,purpose:'authenticate',kind:'totp',factorGrant:{grantId:'factor-grant:totp',factorRef:ref,purpose:'authenticate',kind:'totp',expiresAtMs:10_500,source:trusted},consequenceGrants:[consequence]}});
  assert.equal(JSON.stringify(completed).includes(ref),false);
});
