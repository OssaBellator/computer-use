import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsUiaCacheState } from '../src/computer/windowsUiaCacheState.js';
import { DesktopInteractionLeaseManager } from '../src/computer/desktopInteractionLease.js';
import { WindowsNativeInputGate } from '../src/computer/windowsNativeInputGate.js';
import type { WindowsUiaWindowRef } from '../src/computer/windowsUiaContract.js';

const windowRef: WindowsUiaWindowRef = Object.freeze({
  hwnd:'0x99',
  desktopSessionId:'interactive:1',
  process:Object.freeze({processId:77,startIdentity:'start-77'}),
  generation:4,
});

const surface = Object.freeze({
  adapterId:'desktop:windows',
  environment:'desktop-ui' as const,
  surfaceId:'0x99',
  generation:4,
});

test('UIA event invalidates cache lease instead of becoming proof', () => {
  const state = new WindowsUiaCacheState();
  const lease = state.register({window:windowRef,itemCount:1,textBytes:0,truncated:false,invalidationEpoch:3,capturedAtMs:10});
  assert.deepEqual(state.validate(lease,windowRef),{status:'current'});
  state.invalidate(windowRef,4,'structure-changed');
  assert.deepEqual(state.validate(lease,windowRef),{status:'invalidated',reason:'structure-changed'});
});

test('UIA cache lease rejects window generation replacement and epoch regression', () => {
  const state = new WindowsUiaCacheState();
  const lease = state.register({window:windowRef,itemCount:0,textBytes:0,truncated:false,invalidationEpoch:8,capturedAtMs:1});
  assert.deepEqual(state.validate(lease,{...windowRef,generation:5}),{status:'window-mismatch'});
  assert.throws(() => state.register({window:windowRef,itemCount:0,textBytes:0,truncated:false,invalidationEpoch:7,capturedAtMs:2}),/epoch-regressed/);
});

test('native input gate requires interactive lease and equal-or-lower target integrity', async () => {
  let sequence = 10;
  const leases = new DesktopInteractionLeaseManager({snapshot:async()=>({sequence})},()=>100);
  const lease = await leases.acquire({leaseId:'native-input',mode:'interactive-host',targetDesktop:'desktop-1',targetSurface:surface,durationMs:1_000});
  const gate = new WindowsNativeInputGate(leases);
  let calls = 0;
  const blocked = await gate.dispatch({lease,targetDesktop:'desktop-1',targetSurface:surface,integrity:{caller:'medium',target:'high'},effect:'local-reversible'},{dispatch:async()=>{calls+=1;return {requestedEventCount:1,insertedEventCount:1};}});
  assert.equal(blocked.dispatch,'not-dispatched');
  assert.deepEqual(blocked.evidence,['uipi-higher-integrity-target']);
  assert.equal(calls,0);

  sequence += 1;
  const interfered = await gate.dispatch({lease,targetDesktop:'desktop-1',targetSurface:surface,integrity:{caller:'medium',target:'medium'},effect:'local-reversible'},{dispatch:async()=>{calls+=1;return {requestedEventCount:1,insertedEventCount:1};}});
  assert.equal(interfered.dispatch,'not-dispatched');
  assert.deepEqual(interfered.evidence,['windows-input-lease-human-interference']);
  assert.equal(calls,0);
});

test('partial SendInput insertion is sticky unknown, zero insertion is definitely not dispatched', async () => {
  const leases = new DesktopInteractionLeaseManager({snapshot:async()=>({sequence:1})},()=>100);
  const lease = await leases.acquire({leaseId:'native-partial',mode:'interactive-host',targetDesktop:'desktop-1',targetSurface:surface,durationMs:1_000});
  const gate = new WindowsNativeInputGate(leases);
  const partial = await gate.dispatch({lease,targetDesktop:'desktop-1',targetSurface:surface,integrity:{caller:'high',target:'medium'},effect:'local-reversible'},{dispatch:async()=>({requestedEventCount:3,insertedEventCount:1})});
  assert.deepEqual({status:partial.status,dispatch:partial.dispatch},{status:'unknown',dispatch:'unknown'});
  assert.equal(partial.evidence?.[0],'windows-input-partial-dispatch');

  const zero = await gate.dispatch({lease,targetDesktop:'desktop-1',targetSurface:surface,integrity:{caller:'high',target:'medium'},effect:'local-reversible'},{dispatch:async()=>({requestedEventCount:2,insertedEventCount:0})});
  assert.deepEqual({status:zero.status,dispatch:zero.dispatch},{status:'failed',dispatch:'not-dispatched'});
});

test('native input exception is sticky unknown after dispatch boundary', async () => {
  const leases = new DesktopInteractionLeaseManager({snapshot:async()=>({sequence:1})},()=>100);
  const lease = await leases.acquire({leaseId:'native-unknown',mode:'interactive-host',targetDesktop:'desktop-1',targetSurface:surface,durationMs:1_000});
  const gate = new WindowsNativeInputGate(leases);
  const result = await gate.dispatch({lease,targetDesktop:'desktop-1',targetSurface:surface,integrity:{caller:'high',target:'medium'},effect:'local-reversible'},{dispatch:async()=>{throw new Error('uncertain');}});
  assert.deepEqual({status:result.status,dispatch:result.dispatch},{status:'unknown',dispatch:'unknown'});
});
