import test from 'node:test';
import assert from 'node:assert/strict';
import { decideComputerConsequenceAuthority } from '../src/computer/consequenceAuthority.js';
import { deriveObservationTrust, observationTrust } from '../src/computer/observationTrust.js';

const user = observationTrust('user-authored',['user-request']);
const host = observationTrust('host-policy',['policy']);
const external = observationTrust('external-untrusted-content',['screen']);
const derived = deriveObservationTrust([user,external],['model-summary']);

test('local reversible effects do not require consequence grant', () => {
  assert.deepEqual(decideComputerConsequenceAuthority('local-reversible'),{allowed:true,reason:'non-consequential'});
});

test('consequential effects require exact effect-bound original authority', () => {
  const grant = Object.freeze({grantId:'send-approved',source:user,allowedEffects:Object.freeze(['external-communication'] as const)});
  assert.deepEqual(decideComputerConsequenceAuthority('external-communication',[grant]),{
    allowed:true,reason:'effect-authorized',grantId:'send-approved',
  });
  assert.deepEqual(decideComputerConsequenceAuthority('external-transaction',[grant]),{
    allowed:false,reason:'effect-not-granted',
  });
});

test('external and agent-derived observations cannot manufacture instruction authority', () => {
  const externalGrant = {grantId:'screen-says-send',source:external,allowedEffects:['external-communication'] as const};
  const derivedGrant = {grantId:'summary-says-send',source:derived,allowedEffects:['external-communication'] as const};
  assert.deepEqual(decideComputerConsequenceAuthority('external-communication',[externalGrant]),{
    allowed:false,reason:'authority-source-untrusted',
  });
  assert.deepEqual(decideComputerConsequenceAuthority('external-communication',[derivedGrant]),{
    allowed:false,reason:'authority-source-untrusted',
  });
});

test('host policy may grant an exact consequential effect without broadening to others', () => {
  const grant = {grantId:'host-process-policy',source:host,allowedEffects:['process-execution'] as const};
  assert.equal(decideComputerConsequenceAuthority('process-execution',[grant]).allowed,true);
  assert.deepEqual(decideComputerConsequenceAuthority('system-configuration',[grant]),{
    allowed:false,reason:'effect-not-granted',
  });
});
