import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateComputerUseCapabilityProfileSnapshot,
} from '../src/computer/computerUseCapabilityProfileSnapshotValidation.js';

test('top-level profile accessors are rejected without invocation', () => {
  let getterCalls = 0;
  const profile: Record<string, unknown> = {
    version: '1.0',
    kind: 'component',
    capabilities: {},
  };
  Object.defineProperty(profile, 'id', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'fixture';
    },
  });

  assert.deepEqual(validateComputerUseCapabilityProfileSnapshot(profile), ['profile.id.invalid']);
  assert.equal(getterCalls, 0);
});

test('capability state accessors are rejected without invocation', () => {
  let getterCalls = 0;
  const capabilities: Record<string, unknown> = {};
  Object.defineProperty(capabilities, 'file-read', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return { status: 'implemented', scopes: ['filesystem'] };
    },
  });

  const errors = validateComputerUseCapabilityProfileSnapshot({
    id: 'fixture',
    version: '1.0',
    kind: 'component',
    capabilities,
  });

  assert.deepEqual(errors, ['capability.state.invalid:file-read']);
  assert.equal(getterCalls, 0);
});

test('status, scopes, and note accessors are rejected without invocation', () => {
  let getterCalls = 0;
  const state: Record<string, unknown> = {};
  for (const key of ['status', 'scopes', 'note']) {
    Object.defineProperty(state, key, {
      enumerable: true,
      get() {
        getterCalls += 1;
        return key === 'status' ? 'implemented' : key === 'scopes' ? ['filesystem'] : 'note';
      },
    });
  }

  const errors = validateComputerUseCapabilityProfileSnapshot({
    id: 'fixture',
    version: '1.0',
    kind: 'component',
    capabilities: { 'file-read': state },
  });

  assert.deepEqual(errors, [
    'capability.status.invalid:file-read',
    'capability.scope.invalid:file-read',
    'capability.note.invalid:file-read',
  ]);
  assert.equal(getterCalls, 0);
});

test('accessor-backed scope elements are rejected without invocation', () => {
  let getterCalls = 0;
  const scopes = ['filesystem'];
  Object.defineProperty(scopes, '0', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls += 1;
      return 'filesystem';
    },
  });

  const errors = validateComputerUseCapabilityProfileSnapshot({
    id: 'fixture',
    version: '1.0',
    kind: 'component',
    capabilities: {
      'file-read': { status: 'implemented', scopes },
    },
  });

  assert.deepEqual(errors, ['capability.scope.invalid:file-read']);
  assert.equal(getterCalls, 0);
});
