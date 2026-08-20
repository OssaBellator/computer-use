import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_COMPUTER_USE_CAPABILITY_PROFILE,
} from '../src/computer/computerUseCapabilityProfiles.js';
import {
  snapshotComputerUseCapabilityProfile,
} from '../src/computer/computerUseCapabilityProfileSnapshot.js';

test('snapshot adoption copies caller-owned profile data before freezing it', () => {
  const input = {
    id: 'fixture',
    version: '1.0',
    kind: 'component',
    capabilities: {
      'file-read': {
        status: 'implemented',
        scopes: ['filesystem'],
        note: 'bounded read',
      },
    },
  };

  const adopted = snapshotComputerUseCapabilityProfile(input);

  input.id = 'mutated';
  input.capabilities['file-read'].status = 'unsupported';
  input.capabilities['file-read'].scopes.push('browser');
  input.capabilities['file-read'].note = 'mutated';

  assert.equal(adopted.id, 'fixture');
  assert.equal(adopted.capabilities['file-read']?.status, 'implemented');
  assert.deepEqual(adopted.capabilities['file-read']?.scopes, ['filesystem']);
  assert.equal(adopted.capabilities['file-read']?.note, 'bounded read');
});

test('snapshot adoption deeply freezes profile, capability states, and scopes', () => {
  const adopted = snapshotComputerUseCapabilityProfile({
    id: 'fixture',
    version: '1.0',
    kind: 'component',
    capabilities: {
      'file-read': {
        status: 'implemented',
        scopes: ['filesystem'],
      },
    },
  });

  const state = adopted.capabilities['file-read'];
  assert.equal(Object.isFrozen(adopted), true);
  assert.equal(Object.isFrozen(adopted.capabilities), true);
  assert.equal(Object.isFrozen(state), true);
  assert.equal(Object.isFrozen(state?.scopes), true);
});

test('snapshot adoption rejects malformed input with validator error codes', () => {
  assert.throws(
    () => snapshotComputerUseCapabilityProfile({
      id: 'fixture',
      version: 'latest',
      kind: 'component',
      capabilities: {},
    }),
    /profile\.version\.invalid/u,
  );
});

test('current integrated profile round-trips through serialized snapshot adoption', () => {
  const serialized = JSON.parse(JSON.stringify(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE)) as unknown;
  const adopted = snapshotComputerUseCapabilityProfile(serialized, {
    requireComplete: true,
    requireExplicitHighRisk: true,
  });

  assert.deepEqual(adopted, CURRENT_COMPUTER_USE_CAPABILITY_PROFILE);
});

test('partial component snapshots remain partial rather than being silently completed', () => {
  const adopted = snapshotComputerUseCapabilityProfile({
    id: 'fixture',
    version: '1.0',
    kind: 'component',
    capabilities: {
      'local-compute': {
        status: 'implemented',
        scopes: ['local-compute'],
      },
    },
  });

  assert.deepEqual(Object.keys(adopted.capabilities), ['local-compute']);
  assert.equal(adopted.capabilities['file-read'], undefined);
});
