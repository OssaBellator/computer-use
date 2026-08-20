import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_COMPUTER_USE_CAPABILITY_PROFILE,
} from '../src/computer/computerUseCapabilityProfiles.js';
import {
  isComputerUseCapabilityProfileSnapshot,
  validateComputerUseCapabilityProfileSnapshot,
} from '../src/computer/computerUseCapabilityProfileSnapshotValidation.js';

test('current integrated profile is accepted as a complete serialized snapshot', () => {
  const snapshot = JSON.parse(JSON.stringify(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE)) as unknown;
  assert.deepEqual(
    validateComputerUseCapabilityProfileSnapshot(snapshot, {
      requireComplete: true,
      requireExplicitHighRisk: true,
    }),
    [],
  );
  assert.equal(isComputerUseCapabilityProfileSnapshot(snapshot), true);
});

test('malformed top-level snapshots fail closed without throwing', () => {
  assert.deepEqual(validateComputerUseCapabilityProfileSnapshot(null), ['profile.invalid']);
  assert.deepEqual(validateComputerUseCapabilityProfileSnapshot([]), ['profile.invalid']);

  const errors = validateComputerUseCapabilityProfileSnapshot({
    id: 7,
    version: 'latest',
    kind: 'browser',
    capabilities: null,
  });
  assert.deepEqual(errors, [
    'profile.id.invalid',
    'profile.version.invalid',
    'profile.kind.invalid',
    'profile.capabilities.invalid',
  ]);
});

test('malformed capability states report deterministic structural errors', () => {
  const errors = validateComputerUseCapabilityProfileSnapshot({
    id: 'fixture',
    version: '1.0',
    kind: 'component',
    capabilities: {
      'file-read': {
        status: 'available',
        scopes: ['filesystem', 'filesystem', 'unknown-scope'],
        note: 42,
      },
      'not-a-capability': {
        status: 'implemented',
        scopes: ['filesystem'],
      },
      'file-write': 'implemented',
    },
  });

  assert.deepEqual(errors, [
    'capability.status.invalid:file-read',
    'capability.scope.duplicate:file-read:filesystem',
    'capability.scope.invalid:file-read',
    'capability.note.invalid:file-read',
    'capability.unknown:not-a-capability',
    'capability.state.invalid:file-write',
  ]);
});

test('snapshot validation can require completeness and explicit high-risk entries', () => {
  const errors = validateComputerUseCapabilityProfileSnapshot({
    id: 'fixture',
    version: '1.0',
    kind: 'component',
    capabilities: {
      'storage-partitioning': {
        status: 'unsupported',
        scopes: ['system-device'],
      },
    },
  }, {
    requireComplete: true,
    requireExplicitHighRisk: true,
  });

  assert.ok(errors.includes('capability.missing:file-delete'));
  assert.ok(errors.includes('high-risk-capability.not-explicit:file-delete'));
  assert.ok(!errors.includes('high-risk-capability.not-explicit:storage-partitioning'));
});

test('type guard rejects malformed snapshots and accepts valid component shape', () => {
  assert.equal(isComputerUseCapabilityProfileSnapshot({}), false);
  assert.equal(isComputerUseCapabilityProfileSnapshot({
    id: 'filesystem-fixture',
    version: '1.0',
    kind: 'component',
    capabilities: {
      'file-read': {
        status: 'implemented',
        scopes: ['filesystem'],
      },
    },
  }), true);
});
