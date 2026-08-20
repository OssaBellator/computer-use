import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_COMPUTER_USE_CAPABILITY_PROFILE,
  type ComputerUseCapabilityProfile,
} from '../src/computer/computerUseCapabilityProfiles.js';
import {
  serializeComputerUseCapabilityProfileCanonical,
} from '../src/computer/computerUseCapabilityProfileSerialization.js';
import {
  validateComputerUseCapabilityProfileSnapshot,
} from '../src/computer/computerUseCapabilityProfileSnapshotValidation.js';

function profile(
  id: string,
  capabilities: ComputerUseCapabilityProfile['capabilities'],
): ComputerUseCapabilityProfile {
  return { id, version: '1.0', kind: 'component', capabilities };
}

test('canonical serialization ignores capability object insertion order', () => {
  const first = profile('fixture', {
    'file-read': { status: 'implemented', scopes: ['filesystem'] },
    'terminal-execution': { status: 'implemented', scopes: ['terminal'] },
  });
  const second = profile('fixture', {
    'terminal-execution': { status: 'implemented', scopes: ['terminal'] },
    'file-read': { status: 'implemented', scopes: ['filesystem'] },
  });

  assert.equal(
    serializeComputerUseCapabilityProfileCanonical(first),
    serializeComputerUseCapabilityProfileCanonical(second),
  );
});

test('canonical serialization sorts scope provenance deterministically', () => {
  const first = profile('fixture', {
    'document-editing': {
      status: 'partial',
      scopes: ['document-model', 'browser'],
      note: 'same evidence',
    },
  });
  const second = profile('fixture', {
    'document-editing': {
      status: 'partial',
      scopes: ['browser', 'document-model'],
      note: 'same evidence',
    },
  });

  assert.equal(
    serializeComputerUseCapabilityProfileCanonical(first),
    serializeComputerUseCapabilityProfileCanonical(second),
  );
  assert.match(
    serializeComputerUseCapabilityProfileCanonical(first),
    /"scopes":\["browser","document-model"\]/u,
  );
});

test('canonical serialization preserves partial component shape', () => {
  const serialized = serializeComputerUseCapabilityProfileCanonical(profile('fixture', {
    'local-compute': { status: 'implemented', scopes: ['local-compute'] },
  }));
  const parsed = JSON.parse(serialized) as { capabilities: Record<string, unknown> };

  assert.deepEqual(Object.keys(parsed.capabilities), ['local-compute']);
});

test('canonical integrated serialization remains a valid complete snapshot', () => {
  const serialized = serializeComputerUseCapabilityProfileCanonical(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE);
  const parsed = JSON.parse(serialized) as unknown;

  assert.deepEqual(
    validateComputerUseCapabilityProfileSnapshot(parsed, {
      requireComplete: true,
      requireExplicitHighRisk: true,
    }),
    [],
  );
});

test('note changes remain visible in canonical serialization', () => {
  const before = profile('fixture', {
    'remote-desktop': {
      status: 'backend-required',
      scopes: ['remote-session'],
      note: 'transport backend required',
    },
  });
  const after = profile('fixture', {
    'remote-desktop': {
      status: 'backend-required',
      scopes: ['remote-session'],
      note: 'production transport backend required',
    },
  });

  assert.notEqual(
    serializeComputerUseCapabilityProfileCanonical(before),
    serializeComputerUseCapabilityProfileCanonical(after),
  );
});
