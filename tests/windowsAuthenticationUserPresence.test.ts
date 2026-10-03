import test from 'node:test';
import assert from 'node:assert/strict';
import { observationTrust } from '../src/computer/observationTrust.js';
import { decideWindowsAuthenticationUserPresence, windowsAuthenticationUserPresenceMaxTtlMs } from '../src/computer/windowsAuthenticationUserPresence.js';

const trusted=observationTrust('user-authored',['auth']);
const app=observationTrust('trusted-application-state',['webauthn']);
const external=observationTrust('external-untrusted-content',['web']);
const challenge=Object.freeze({challengeRef:'presence:challenge:1',factorRef:'factor:hello:work',kind:'windows-hello' as const,purpose:'authenticate' as const,issuedAtMs:10_000,expiresAtMs:20_000,source:trusted});
function observation(state:'pending'|'completed'|'rejected'|'unknown',source=app){return Object.freeze({challengeRef:challenge.challengeRef,state,sequence:1,capturedAtMs:10_500,source});}

test('trusted completed user-presence ceremony is evidence but not factor material',()=>{
  const decision=decideWindowsAuthenticationUserPresence(challenge,observation('completed'),11_000);
  assert.deepEqual(decision,{status:'completed',evidence:['windows-auth-presence-completed']});
  assert.equal(JSON.stringify(decision).includes(challenge.factorRef),false);
});

test('pending Hello/passkey ceremony remains user-presence-required',()=>{
  const decision=decideWindowsAuthenticationUserPresence(challenge,observation('pending'),11_000);
  assert.equal(decision.status,'user-presence-required');
});

test('external webpage content cannot prove a user-presence ceremony completed',()=>{
  const decision=decideWindowsAuthenticationUserPresence(challenge,observation('completed',external),11_000);
  assert.equal(decision.status,'unknown');
  assert.ok(decision.evidence.includes('windows-auth-presence-observation-untrusted'));
});

test('expired or overlong challenges require a fresh user-presence ceremony',()=>{
  assert.equal(decideWindowsAuthenticationUserPresence(challenge,observation('completed'),20_000).status,'user-presence-required');
  const overlong={...challenge,challengeRef:'presence:challenge:2',expiresAtMs:10_000+windowsAuthenticationUserPresenceMaxTtlMs()+1};
  assert.equal(decideWindowsAuthenticationUserPresence(overlong,{...observation('pending'),challengeRef:overlong.challengeRef},11_000).status,'rejected');
});

test('challenge identity and observation freshness are exact',()=>{
  const wrong={...observation('completed'),challengeRef:'presence:challenge:other'};
  assert.equal(decideWindowsAuthenticationUserPresence(challenge,wrong,11_000).status,'unknown');
  const stale={...observation('completed'),capturedAtMs:9_999};
  assert.equal(decideWindowsAuthenticationUserPresence(challenge,stale,11_000).status,'unknown');
});

test('TOTP cannot be represented as a user-presence ceremony',()=>{
  const invalid={...challenge,kind:'totp' as const};
  const decision=decideWindowsAuthenticationUserPresence(invalid as never,observation('pending'),11_000);
  assert.equal(decision.status,'rejected');
});
