import assert from 'node:assert/strict';
import test from 'node:test';

import {
  fingerprintComputerUseCapabilityProfile,
} from '../src/computer/computerUseCapabilityProfileFingerprint.js';
import {
  CURRENT_COMPUTER_USE_CAPABILITY_PROFILE,
  type ComputerUseCapabilityProfile,
} from '../src/computer/computerUseCapabilityProfiles.js';

function profile(
  id: string,
  capabilities: ComputerUseCapabilityProfile['capabilities'],
): ComputerUseCapabilityProfile {
  return { id, version: '1.0', kind: 'component', capabilities };
}

test('fingerprints are stable across capability insertion and scope ordering', () => {
  const first = profile('fixture', {
    'file-read': { status: 'implemented', scopes: ['filesystem'] },
    'document-editing': {
      status: 'partial',
      scopes: ['document-model', 'browser'],
      note: 'bounded integration',
    },
  });
  const second = profile('fixture', {
    'document-editing': {
      status: 'partial',
      scopes: ['browser', 'document-model'],
      note: 'bounded integration',
    },
    'file-read': { status: 'implemented', scopes: ['filesystem'] },
  });

  assert.equal(
    fingerprintComputerUseCapabilityProfile(first),
    fingerprintComputerUseCapabilityProfile(second),
  );
});

test('fingerprints change when capability semantics change', () => {
  const before = profile('fixture', {
    'file-read': { status: 'implemented', scopes: ['filesystem'], note: 'bounded read' },
  });
  const after = profile('fixture', {
    'file-read': { status: 'partial', scopes: ['filesystem'], note: 'bounded read' },
  });

  assert.notEqual(
    fingerprintComputerUseCapabilityProfile(before),
    fingerprintComputerUseCapabilityProfile(after),
  );
});

test('fingerprints bind profile identity and version', () => {
  const capabilities = {
    'file-read': { status: 'implemented' as const, scopes: ['filesystem' as const] },
  };
  const first = profile('fixture-a', capabilities);
  const second = profile('fixture-b', capabilities);
  const third: ComputerUseCapabilityProfile = {
    id: 'fixture-a', version: '1.1', kind: 'component', capabilities,
  };

  assert.notEqual(
    fingerprintComputerUseCapabilityProfile(first),
    fingerprintComputerUseCapabilityProfile(second),
  );
  assert.notEqual(
    fingerprintComputerUseCapabilityProfile(first),
    fingerprintComputerUseCapabilityProfile(third),
  );
});

test('fingerprint format is explicit sha256 hex', () => {
  const fingerprint = fingerprintComputerUseCapabilityProfile(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE);
  assert.match(fingerprint, /^sha256:[0-9a-f]{64}$/u);
});
