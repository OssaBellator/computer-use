import test from 'node:test';
import assert from 'node:assert/strict';
import { observationTrust } from '../src/computer/observationTrust.js';
import { windowsAuthenticationTaskContinuationGate } from '../src/computer/windowsAuthenticationTaskContinuation.js';
import type { WindowsAuthenticationSessionGrant, WindowsAuthenticationSessionObservation } from '../src/computer/windowsAuthenticationSessionAuthority.js';

const window=Object.freeze({hwnd:'0xaaa',desktopSessionId:'session:1',process:Object.freeze({processId:40,startIdentity:'p40'}),generation:1});
const trusted=observationTrust('user-authored',['auth']);
const grant:WindowsAuthenticationSessionGrant=Object.freeze({sessionGrantId:'session-grant:1',accountRef:'account:work',window,establishedAtMs:10_000,expiresAtMs:20_000,source:trusted});
function observation(overrides:Partial<WindowsAuthenticationSessionObservation>={}):WindowsAuthenticationSessionObservation{return Object.freeze({accountRef:'account:work',window,authenticated:true,reauthenticationRequired:false,sequence:2,capturedAtMs:10_500,...overrides});}

test('authorized authenticated session permits long-horizon task continuation',async()=>{
  const gate=windowsAuthenticationTaskContinuationGate({observe:async()=>({grant,observation:observation(),nowMs:11_000})});
  const decision=await gate();
  assert.equal(decision.state,'continue');
  assert.ok(decision.evidence?.includes('windows-auth-session-authorized'));
});

test('expired session suspends continuation for reauthentication rather than retrying task work',async()=>{
  const gate=windowsAuthenticationTaskContinuationGate({observe:async()=>({grant,observation:observation(),nowMs:20_000})});
  const decision=await gate();
  assert.equal(decision.state,'suspend');
  assert.ok(decision.evidence?.includes('windows-auth-continuation-reauthentication-required'));
});

test('authoritative reauthentication signal suspends before task dispatch',async()=>{
  const gate=windowsAuthenticationTaskContinuationGate({observe:async()=>({grant,observation:observation({reauthenticationRequired:true}),nowMs:11_000})});
  const decision=await gate();
  assert.equal(decision.state,'suspend');
  assert.ok(decision.evidence?.includes('windows-auth-session-reauthentication-signaled'));
});

test('window or account drift suspends for re-observation rather than inheriting old session authority',async()=>{
  const changedWindow={...window,generation:2};
  const gate=windowsAuthenticationTaskContinuationGate({observe:async()=>({grant,observation:observation({window:changedWindow}),nowMs:11_000})});
  const decision=await gate();
  assert.equal(decision.state,'suspend');
  assert.ok(decision.evidence?.includes('windows-auth-continuation-reobserve-required'));
});

test('session provider exception suspends with no task-side authentication inference',async()=>{
  const gate=windowsAuthenticationTaskContinuationGate({observe:async()=>{throw new Error('provider-lost');}});
  const decision=await gate();
  assert.deepEqual(decision,{state:'suspend',evidence:['windows-auth-continuation-provider-unknown']});
});
