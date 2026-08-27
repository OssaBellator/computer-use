import test from 'node:test';
import assert from 'node:assert/strict';
import { observationTrust } from '../src/computer/observationTrust.js';
import { WindowsAuthenticationFactorMediator, type WindowsAuthenticationFactorBroker } from '../src/computer/windowsAuthenticationFactorMediator.js';

const trusted=observationTrust('user-authored',['factor']);
const untrusted=observationTrust('external-untrusted-content',['web']);
const consequence=Object.freeze({grantId:'security-factor',source:trusted,allowedEffects:Object.freeze(['security-sensitive' as const])});
function request(overrides:Record<string,unknown>={}){
  const factorRef='factor:totp:work';
  return {
    factorRef,
    purpose:'authenticate' as const,
    kind:'totp' as const,
    factorGrant:{grantId:'factor-grant:1',factorRef,purpose:'authenticate' as const,kind:'totp' as const,expiresAtMs:10_500,source:trusted},
    consequenceGrants:[consequence],
    ...overrides,
  };
}

test('factor broker receives only opaque ref, purpose, and kind',async()=>{
  let seen:unknown;
  const broker:WindowsAuthenticationFactorBroker={performFactor:async value=>{seen=value;return {status:'completed',evidence:['factor-used']};}};
  const mediator=new WindowsAuthenticationFactorMediator(broker,()=>10_000);
  const out=await mediator.performFactor(request());
  assert.deepEqual(seen,{factorRef:'factor:totp:work',purpose:'authenticate',kind:'totp'});
  assert.equal(out.status,'completed');
  assert.equal(JSON.stringify(seen).includes('factorGrant'),false);
  assert.equal(JSON.stringify(seen).includes('consequenceGrants'),false);
});

test('factor grant is exact-purpose and exact-kind bound',async()=>{
  let calls=0;
  const mediator=new WindowsAuthenticationFactorMediator({performFactor:async()=>{calls+=1;return {status:'completed'};}},()=>10_000);
  const out=await mediator.performFactor(request({kind:'passkey'}));
  assert.equal(out.status,'rejected');
  assert.equal(calls,0);
});

test('external content cannot authorize factor use',async()=>{
  let calls=0;
  const mediator=new WindowsAuthenticationFactorMediator({performFactor:async()=>{calls+=1;return {status:'completed'};}},()=>10_000);
  const base=request();
  const out=await mediator.performFactor({...base,factorGrant:{...base.factorGrant,source:untrusted}});
  assert.equal(out.status,'rejected');
  assert.equal(calls,0);
});

test('factor use independently requires security-sensitive consequence authority',async()=>{
  let calls=0;
  const mediator=new WindowsAuthenticationFactorMediator({performFactor:async()=>{calls+=1;return {status:'completed'};}},()=>10_000);
  const out=await mediator.performFactor({...request(),consequenceGrants:[]});
  assert.equal(out.status,'rejected');
  assert.equal(calls,0);
});

test('factor grants are short-lived and one-shot',async()=>{
  let calls=0;
  const mediator=new WindowsAuthenticationFactorMediator({performFactor:async()=>{calls+=1;return {status:'completed'};}},()=>10_000);
  assert.equal((await mediator.performFactor(request())).status,'completed');
  assert.equal((await mediator.performFactor(request())).status,'rejected');
  assert.equal(calls,1);
  const long=request();
  const unbounded={...long,factorGrant:{...long.factorGrant,grantId:'factor-grant:2',expiresAtMs:70_001}};
  assert.equal((await mediator.performFactor(unbounded)).status,'rejected');
});

test('broker exception is sticky unknown and consumed grant is not retried',async()=>{
  let calls=0;
  const mediator=new WindowsAuthenticationFactorMediator({performFactor:async()=>{calls+=1;throw new Error('lost-boundary');}},()=>10_000);
  const first=await mediator.performFactor(request());
  const second=await mediator.performFactor(request());
  assert.equal(first.status,'unknown');
  assert.deepEqual(first.evidence,['windows-auth-factor-broker-unknown']);
  assert.equal(second.status,'rejected');
  assert.equal(calls,1);
});

test('broker response cannot smuggle factor material or extra fields across the boundary',async()=>{
  const secret='123456';
  const mediator=new WindowsAuthenticationFactorMediator({performFactor:async()=>({status:'completed',secret} as never)},()=>10_000);
  const out=await mediator.performFactor(request());
  assert.equal(out.status,'unknown');
  assert.deepEqual(out.evidence,['windows-auth-factor-broker-response-invalid']);
  assert.equal(JSON.stringify(out).includes(secret),false);
});

test('broker evidence cannot echo the opaque factor reference',async()=>{
  const factorRef='factor:totp:work';
  const mediator=new WindowsAuthenticationFactorMediator({performFactor:async()=>({status:'completed',evidence:[factorRef]})},()=>10_000);
  const out=await mediator.performFactor(request());
  assert.equal(out.status,'unknown');
  assert.deepEqual(out.evidence,['windows-auth-factor-broker-response-invalid']);
});

test('invalid opaque factor reference is rejected before broker boundary',async()=>{
  let calls=0;
  const mediator=new WindowsAuthenticationFactorMediator({performFactor:async()=>{calls+=1;return {status:'completed'};}},()=>10_000);
  const base=request();
  const out=await mediator.performFactor({...base,factorRef:'external text with spaces',factorGrant:{...base.factorGrant,factorRef:'external text with spaces'}});
  assert.equal(out.status,'rejected');
  assert.equal(calls,0);
});
