import test from 'node:test';
import assert from 'node:assert/strict';
import { observationTrust } from '../src/computer/observationTrust.js';
import { WindowsCredentialMediator, type WindowsCredentialBroker } from '../src/computer/windowsCredentialMediator.js';
import type { WindowsUiaProvider, WindowsUiaControlRef, WindowsUiaRevalidation } from '../src/computer/windowsUiaContract.js';

const windowRef=Object.freeze({hwnd:'0xabc',desktopSessionId:'session:1',process:Object.freeze({processId:10,startIdentity:'p10'}),generation:2});
const target:WindowsUiaControlRef=Object.freeze({window:windowRef,runtimeId:Object.freeze([1,2,3]),automationId:'Password',controlType:'Edit',generation:4});
const trusted=observationTrust('user-authored',['credential-use']);
const windows=Object.freeze([{window:windowRef,isModal:false,interactionState:'ready-for-user-interaction' as const}]);
const consequenceGrant=Object.freeze({grantId:'security-use',source:trusted,allowedEffects:Object.freeze(['security-sensitive' as const])});
const credentialGrant=Object.freeze({grantId:'credential-login',credentialRef:'vault:example-login',target,purpose:'authenticate',expiresAtMs:Date.now()+30_000,source:trusted});

function provider(revalidation:WindowsUiaRevalidation):WindowsUiaProvider {
  return {
    observeCached:async()=>{throw new Error('not-used');},
    revalidateControl:async()=>revalidation,
    performSemanticAction:async()=>{throw new Error('must-not-dispatch-semantic-value');},
  };
}
function current(overrides:Record<string,unknown>={}):WindowsUiaRevalidation {
  return {status:'current',control:{ref:target,name:'Password',enabled:true,isPassword:true,patterns:['value'],...overrides}} as WindowsUiaRevalidation;
}

test('credential broker receives only opaque reference, purpose, and exact target',async()=>{
  let request:unknown;
  const broker:WindowsCredentialBroker={applyCredential:async(value)=>{request=value;return {status:'applied',evidence:['broker-applied']};}};
  const mediator=new WindowsCredentialMediator(provider(current()),broker);
  const result=await mediator.apply({target,windows,credentialGrant,consequenceGrants:[consequenceGrant]});
  assert.deepEqual(request,{credentialRef:'vault:example-login',target,purpose:'authenticate'});
  assert.equal(result.status,'completed');
  assert.equal(result.dispatch,'dispatched-once');
  assert.equal(result.verification,'unverified');
  assert.ok(result.evidence?.includes('windows-credential-applied-secret-not-observed'));
  assert.equal(JSON.stringify(result).includes('example-login'),false);
});

test('credential use fails closed unless exact current target is a redacted password control',async()=>{
  let calls=0;
  const broker:WindowsCredentialBroker={applyCredential:async()=>{calls+=1;return {status:'applied'};}};
  const exposed=new WindowsCredentialMediator(provider(current({value:'must-never-cross'})),broker);
  assert.equal((await exposed.apply({target,windows,credentialGrant,consequenceGrants:[consequenceGrant]})).evidence?.[0],'windows-credential-password-value-exposed');
  const ordinary=new WindowsCredentialMediator(provider(current({isPassword:false})),broker);
  assert.equal((await ordinary.apply({target,windows,credentialGrant,consequenceGrants:[consequenceGrant]})).evidence?.[0],'windows-credential-target-not-password');
  assert.equal(calls,0);
});

test('credential grant cannot be redirected to a replaced control or sourced from untrusted screen content',async()=>{
  let calls=0;
  const broker:WindowsCredentialBroker={applyCredential:async()=>{calls+=1;return {status:'applied'};}};
  const other={...target,generation:5};
  const mediator=new WindowsCredentialMediator(provider(current()),broker);
  assert.equal((await mediator.apply({target:other,windows,credentialGrant,consequenceGrants:[consequenceGrant]})).evidence?.[0],'windows-credential-grant-target-mismatch');
  const untrustedGrant={...credentialGrant,source:observationTrust('external-untrusted-content',['screen'])};
  assert.equal((await mediator.apply({target,windows,credentialGrant:untrustedGrant,consequenceGrants:[consequenceGrant]})).evidence?.[0],'windows-credential-grant-invalid');
  assert.equal(calls,0);
});

test('credential use cannot bypass a newly authoritative modal window',async()=>{
  let calls=0;
  const broker:WindowsCredentialBroker={applyCredential:async()=>{calls+=1;return {status:'applied'};}};
  const modalWindow={...windowRef,hwnd:'0xdef',generation:3};
  const blocked=Object.freeze([
    {window:windowRef,isModal:false,interactionState:'blocked-by-modal-window' as const},
    {window:modalWindow,isModal:true,interactionState:'ready-for-user-interaction' as const,owner:windowRef},
  ]);
  const mediator=new WindowsCredentialMediator(provider(current()),broker);
  const result=await mediator.apply({target,windows:blocked,credentialGrant,consequenceGrants:[consequenceGrant]});
  assert.equal(result.evidence?.[0],'windows-credential-window-authority-rerouted-reobserve');
  assert.equal(calls,0);
});

test('credential use requires explicit security-sensitive consequence authority',async()=>{
  let calls=0;
  const broker:WindowsCredentialBroker={applyCredential:async()=>{calls+=1;return {status:'applied'};}};
  const mediator=new WindowsCredentialMediator(provider(current()),broker);
  const result=await mediator.apply({target,windows,credentialGrant});
  assert.equal(result.evidence?.[0],'windows-credential-effect-authority-required');
  assert.equal(calls,0);
});

test('credential grant is short-lived and one-shot across the broker boundary',async()=>{
  let calls=0;
  const broker:WindowsCredentialBroker={applyCredential:async()=>{calls+=1;return {status:'applied'};}};
  const oneShot={...credentialGrant,grantId:'credential-one-shot',expiresAtMs:1_100};
  const mediator=new WindowsCredentialMediator(provider(current()),broker,()=>1_000);
  assert.equal((await mediator.apply({target,windows,credentialGrant:oneShot,consequenceGrants:[consequenceGrant]})).status,'completed');
  assert.equal((await mediator.apply({target,windows,credentialGrant:oneShot,consequenceGrants:[consequenceGrant]})).evidence?.[0],'windows-credential-grant-consumed');
  const expired=new WindowsCredentialMediator(provider(current()),broker,()=>1_101);
  assert.equal((await expired.apply({target,windows,credentialGrant:{...oneShot,grantId:'credential-expired'},consequenceGrants:[consequenceGrant]})).evidence?.[0],'windows-credential-grant-invalid');
  assert.equal(calls,1);
});

test('broker exception is sticky UNKNOWN and consumes credential authority',async()=>{
  let calls=0;
  const broker:WindowsCredentialBroker={applyCredential:async()=>{calls+=1;throw new Error('boundary-lost');}};
  const mediator=new WindowsCredentialMediator(provider(current()),broker);
  const result=await mediator.apply({target,windows,credentialGrant,consequenceGrants:[consequenceGrant]});
  assert.deepEqual(result,{status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['windows-credential-broker-unknown']});
  assert.equal((await mediator.apply({target,windows,credentialGrant,consequenceGrants:[consequenceGrant]})).evidence?.[0],'windows-credential-grant-consumed');
  assert.equal(calls,1);
});
