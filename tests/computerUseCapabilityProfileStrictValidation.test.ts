import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_COMPUTER_USE_CAPABILITY_PROFILE,
  type ComputerUseCapabilityProfile,
} from '../src/computer/computerUseCapabilityProfiles.js';
import {
  validateComputerUseCapabilityProfileStrict,
} from '../src/computer/computerUseCapabilityProfileStrictValidation.js';
import {
  validateComputerUseCapabilityProfileSnapshot,
} from '../src/computer/computerUseCapabilityProfileSnapshotValidation.js';

test('current integrated profile passes strict typed validation', () => {
  assert.deepEqual(validateComputerUseCapabilityProfileStrict(
    CURRENT_COMPUTER_USE_CAPABILITY_PROFILE,
    { requireComplete: true, requireExplicitHighRisk: true },
  ), []);
});

test('strict typed validation rejects duplicate scope provenance', () => {
  const profile: ComputerUseCapabilityProfile = {
    id: 'duplicate-scope-fixture',
    version: '1.0',
    kind: 'component',
    capabilities: {
      'document-editing': {
        status: 'partial',
        scopes: ['browser', 'browser'],
      },
    },
  };

  assert.deepEqual(validateComputerUseCapabilityProfileStrict(profile), [
    'capability.scope.duplicate:document-editing:browser',
  ]);
});

test('strict typed and serialized validators use the same duplicate-scope error code', () => {
  const profile: ComputerUseCapabilityProfile = {
    id: 'duplicate-scope-fixture',
    version: '1.0',
    kind: 'component',
    capabilities: {
      'remote-desktop': {
        status: 'backend-required',
        scopes: ['remote-session', 'remote-session'],
      },
    },
  };

  const typedErrors = validateComputerUseCapabilityProfileStrict(profile);
  const snapshotErrors = validateComputerUseCapabilityProfileSnapshot(
    JSON.parse(JSON.stringify(profile)) as unknown,
  );

  assert.deepEqual(typedErrors, [
    'capability.scope.duplicate:remote-desktop:remote-session',
  ]);
  assert.deepEqual(snapshotErrors, typedErrors);
});

test('strict validation preserves base completeness and high-risk options', () => {
  const profile: ComputerUseCapabilityProfile = {
    id: 'partial-fixture',
    version: '1.0',
    kind: 'component',
    capabilities: {
      'storage-partitioning': {
        status: 'unsupported',
        scopes: ['system-device'],
      },
    },
  };

  const errors = validateComputerUseCapabilityProfileStrict(profile, {
    requireComplete: true,
    requireExplicitHighRisk: true,
  });

  assert.ok(errors.includes('capability.missing:file-delete'));
  assert.ok(errors.includes('high-risk-capability.not-explicit:file-delete'));
  assert.ok(!errors.includes('high-risk-capability.not-explicit:storage-partitioning'));
});
