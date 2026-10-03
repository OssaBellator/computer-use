import test from 'node:test';
import assert from 'node:assert/strict';
import { observationTrust } from '../src/computer/observationTrust.js';
import {
  decideWindowsAuthenticationSessionAuthority,
  windowsAuthenticationSessionMaxTtlMs,
  type WindowsAuthenticationSessionGrant,
  type WindowsAuthenticationSessionObservation,
} from '../src/computer/windowsAuthenticationSessionAuthority.js';

const trusted=observationTrust('user-authored',['session']);
const untrusted=observationTrust('external-untrusted-content',['web']);
const windowRef=Object.freeze({hwnd:'0xabc',desktopSessionId:'session:1',process:Object.freeze({processId:55,startIdentity:'p55'}),generation:3});
const grant:WindowsAuthenticationSessionGrant=Object.freeze({
  sessionGrantId:'session-grant:1',
  accountRef:'account:work',
  window:windowRef,
  establishedAtMs:10_000,
  expiresAtMs:20_000,
  source:trusted,
});
function observation(overrides:Partial<WindowsAuthenticationSessionObservation>={}):WindowsAuthenticationSessionObservation{
  return Object.freeze({accountRef:'account:work',window:windowRef,authenticated:true,reauthenticationRequired:false,sequence:5,capturedAtMs:11_000,...overrides});
}

test('authorizes only the exact current authenticated account/window context',()=>{
  const decision=decideWindowsAuthenticationSessionAuthority(grant,observation(),12_000);
  assert.equal(decision.status,'authorized');
  assert.equal(decision.evidence.includes('windows-auth-session-authorized'),true);
});

test('expired authentication session requires a fresh ceremony',()=>{
  const decision=decideWindowsAuthenticationSessionAuthority(grant,observation(),20_000);
  assert.equal(decision.status,'reauthentication-required');
  assert.deepEqual(decision.evidence,['windows-auth-session-expired']);
});

test('stale pre-login observation cannot authorize session reuse',()=>{
  const decision=decideWindowsAuthenticationSessionAuthority(grant,observation({capturedAtMs:9_999}),12_000);
  assert.equal(decision.status,'reobserve-required');
  assert.deepEqual(decision.evidence,['windows-auth-session-observation-stale']);
});

test('window generation replacement invalidates prior session authority',()=>{
  const replaced=Object.freeze({...windowRef,generation:4});
  const decision=decideWindowsAuthenticationSessionAuthority(grant,observation({window:replaced}),12_000);
  assert.equal(decision.status,'reobserve-required');
});

test('account switch cannot reuse a previous account session grant',()=>{
  const decision=decideWindowsAuthenticationSessionAuthority(grant,observation({accountRef:'account:personal'}),12_000);
  assert.equal(decision.status,'reobserve-required');
  assert.deepEqual(decision.evidence,['windows-auth-session-account-changed']);
});

test('authoritative reauthentication signal overrides an otherwise current session',()=>{
  const decision=decideWindowsAuthenticationSessionAuthority(grant,observation({reauthenticationRequired:true}),12_000);
  assert.equal(decision.status,'reauthentication-required');
  assert.deepEqual(decision.evidence,['windows-auth-session-reauthentication-signaled']);
});

test('external content cannot manufacture reusable authenticated-session authority',()=>{
  const decision=decideWindowsAuthenticationSessionAuthority({...grant,source:untrusted},observation(),12_000);
  assert.equal(decision.status,'rejected');
  assert.deepEqual(decision.evidence,['windows-auth-session-source-untrusted']);
});

test('session grant lifetime is bounded independently of caller request',()=>{
  const tooLong={...grant,expiresAtMs:grant.establishedAtMs+windowsAuthenticationSessionMaxTtlMs()+1};
  const decision=decideWindowsAuthenticationSessionAuthority(tooLong,observation(),12_000);
  assert.equal(decision.status,'rejected');
  assert.deepEqual(decision.evidence,['windows-auth-session-lifetime-invalid']);
});
