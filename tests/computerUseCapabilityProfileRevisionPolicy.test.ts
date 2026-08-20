import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateComputerUseCapabilityProfileRevisionTransition,
} from '../src/computer/computerUseCapabilityProfileRevisionPolicy.js';
import type { ComputerUseCapabilityProfile } from '../src/computer/computerUseCapabilityProfiles.js';

function profile(
  id: string,
  version: string,
  capabilities: ComputerUseCapabilityProfile['capabilities'],
): ComputerUseCapabilityProfile {
  return { id, version, kind: 'component', capabilities };
}

test('same profile id and version reject capability-state changes', () => {
  const before = profile('filesystem-profile', '1.0', {
    'file-read': { status: 'unsupported', scopes: ['filesystem'] },
  });
  const after = profile('filesystem-profile', '1.0', {
    'file-read': { status: 'implemented', scopes: ['filesystem'] },
  });

  assert.deepEqual(validateComputerUseCapabilityProfileRevisionTransition(before, after), [
    'profile.revision.changed-without-version-bump:filesystem-profile:1.0',
  ]);
});

test('same profile id and version reject provenance or note drift', () => {
  const before = profile('remote-profile', '1.0', {
    'remote-desktop': {
      status: 'backend-required',
      scopes: ['remote-session'],
      note: 'transport backend required',
    },
  });
  const after = profile('remote-profile', '1.0', {
    'remote-desktop': {
      status: 'backend-required',
      scopes: ['browser', 'remote-session'],
      note: 'production transport backend required',
    },
  });

  assert.deepEqual(validateComputerUseCapabilityProfileRevisionTransition(before, after), [
    'profile.revision.changed-without-version-bump:remote-profile:1.0',
  ]);
});

test('semantically equal profiles tolerate insertion and scope-order differences', () => {
  const before = profile('document-profile', '1.0', {
    'file-read': { status: 'implemented', scopes: ['filesystem'] },
    'document-editing': { status: 'partial', scopes: ['document-model', 'browser'] },
  });
  const after = profile('document-profile', '1.0', {
    'document-editing': { status: 'partial', scopes: ['browser', 'document-model'] },
    'file-read': { status: 'implemented', scopes: ['filesystem'] },
  });

  assert.deepEqual(validateComputerUseCapabilityProfileRevisionTransition(before, after), []);
});

test('version bumps allow intentional semantic changes under the same profile id', () => {
  const before = profile('filesystem-profile', '1.0', {
    'file-read': { status: 'unsupported', scopes: ['filesystem'] },
  });
  const after = profile('filesystem-profile', '1.1', {
    'file-read': { status: 'implemented', scopes: ['filesystem'] },
  });

  assert.deepEqual(validateComputerUseCapabilityProfileRevisionTransition(before, after), []);
});

test('new profile identities are independent even when versions match', () => {
  const before = profile('browser-profile', '0.43', {
    'document-editing': { status: 'partial', scopes: ['browser'] },
  });
  const after = profile('computer-use-profile', '0.43', {
    'document-editing': { status: 'implemented-foundation', scopes: ['document-model'] },
  });

  assert.deepEqual(validateComputerUseCapabilityProfileRevisionTransition(before, after), []);
});
