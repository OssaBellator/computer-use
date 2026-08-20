import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_COMPUTER_USE_CAPABILITY_PROFILE,
  HIGH_RISK_COMPUTER_CAPABILITIES,
  computerCapabilityImplementationState,
} from '../src/computer/computerUseCapabilityProfiles.js';

const EXPECTED_HIGH_RISK_STATUS = {
  'file-delete': 'unsupported',
  'storage-partitioning': 'unsupported',
  'process-control': 'unsupported',
  'software-installation': 'unsupported',
  'system-settings': 'backend-required',
  'security-settings': 'backend-required',
  'device-settings': 'backend-required',
  'hardware-device-control': 'backend-required',
} as const;

test('integrated high-risk capabilities remain explicit and non-implemented', () => {
  assert.deepEqual(
    [...HIGH_RISK_COMPUTER_CAPABILITIES].sort(),
    Object.keys(EXPECTED_HIGH_RISK_STATUS).sort(),
  );

  for (const capability of HIGH_RISK_COMPUTER_CAPABILITIES) {
    const state = computerCapabilityImplementationState(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE, capability);
    assert.equal(state.status, EXPECTED_HIGH_RISK_STATUS[capability], capability);
    assert.notEqual(state.status, 'implemented', capability);
    assert.notEqual(state.status, 'partial', capability);
    assert.notEqual(state.status, 'implemented-foundation', capability);
  }
});

test('destructive high-risk capabilities stay unsupported', () => {
  for (const capability of [
    'file-delete',
    'storage-partitioning',
    'process-control',
    'software-installation',
  ] as const) {
    assert.equal(
      computerCapabilityImplementationState(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE, capability).status,
      'unsupported',
      capability,
    );
  }
});

test('system and device mutation capabilities require a production backend', () => {
  for (const capability of [
    'system-settings',
    'security-settings',
    'device-settings',
    'hardware-device-control',
  ] as const) {
    assert.equal(
      computerCapabilityImplementationState(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE, capability).status,
      'backend-required',
      capability,
    );
  }
});
