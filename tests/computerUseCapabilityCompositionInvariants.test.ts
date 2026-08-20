import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composeComputerUseCapabilityProfiles,
  computerCapabilityImplementationState,
  type ComputerUseCapabilityProfile,
} from '../src/computer/computerUseCapabilityProfiles.js';

const FOUNDATION_PROFILE: ComputerUseCapabilityProfile = {
  id: 'foundation-profile',
  version: '1.0',
  kind: 'component',
  capabilities: {
    'document-editing': {
      status: 'implemented-foundation',
      scopes: ['document-model'],
      note: 'semantic document foundation',
    },
    'remote-desktop': {
      status: 'backend-required',
      scopes: ['remote-session'],
      note: 'transport backend required',
    },
  },
};

const IMPLEMENTATION_PROFILE: ComputerUseCapabilityProfile = {
  id: 'implementation-profile',
  version: '1.0',
  kind: 'component',
  capabilities: {
    'document-editing': {
      status: 'partial',
      scopes: ['browser'],
      note: 'browser editing is partial',
    },
    'remote-desktop': {
      status: 'unsupported',
      scopes: ['browser'],
      note: 'browser navigation is not remote desktop',
    },
  },
};

test('composition is order-independent for states, scopes, and notes', () => {
  const forward = composeComputerUseCapabilityProfiles(
    'forward',
    '1.0',
    [FOUNDATION_PROFILE, IMPLEMENTATION_PROFILE],
  );
  const reverse = composeComputerUseCapabilityProfiles(
    'reverse',
    '1.0',
    [IMPLEMENTATION_PROFILE, FOUNDATION_PROFILE],
  );

  assert.deepEqual(forward.capabilities, reverse.capabilities);
});

test('composition preserves strongest state while retaining deterministic provenance', () => {
  const composed = composeComputerUseCapabilityProfiles(
    'composed',
    '1.0',
    [FOUNDATION_PROFILE, IMPLEMENTATION_PROFILE],
  );

  const documentEditing = computerCapabilityImplementationState(composed, 'document-editing');
  assert.equal(documentEditing.status, 'partial');
  assert.deepEqual(documentEditing.scopes, ['browser', 'document-model']);
  assert.equal(
    documentEditing.note,
    'foundation-profile: semantic document foundation | implementation-profile: browser editing is partial',
  );

  const remoteDesktop = computerCapabilityImplementationState(composed, 'remote-desktop');
  assert.equal(remoteDesktop.status, 'backend-required');
  assert.deepEqual(remoteDesktop.scopes, ['browser', 'remote-session']);
});

test('duplicate component inputs are idempotent in composed provenance', () => {
  const once = composeComputerUseCapabilityProfiles(
    'once',
    '1.0',
    [FOUNDATION_PROFILE],
  );
  const twice = composeComputerUseCapabilityProfiles(
    'twice',
    '1.0',
    [FOUNDATION_PROFILE, FOUNDATION_PROFILE],
  );

  assert.deepEqual(once.capabilities, twice.capabilities);
});

test('composition constructor rejects empty ids, malformed versions, and empty inputs', () => {
  assert.throws(
    () => composeComputerUseCapabilityProfiles('   ', '1.0', [FOUNDATION_PROFILE]),
    /id must be non-empty/u,
  );
  assert.throws(
    () => composeComputerUseCapabilityProfiles('fixture', 'latest', [FOUNDATION_PROFILE]),
    /version is invalid/u,
  );
  assert.throws(
    () => composeComputerUseCapabilityProfiles('fixture', '1.0', []),
    /at least one computer-use capability profile is required/u,
  );
});

test('capabilities omitted by every component remain explicitly unsupported', () => {
  const composed = composeComputerUseCapabilityProfiles(
    'fixture',
    '1.0',
    [FOUNDATION_PROFILE],
  );
  const fileDelete = computerCapabilityImplementationState(composed, 'file-delete');

  assert.equal(fileDelete.status, 'unsupported');
  assert.deepEqual(fileDelete.scopes, []);
  assert.equal(fileDelete.note, 'no integrated component currently provides this capability');
});
