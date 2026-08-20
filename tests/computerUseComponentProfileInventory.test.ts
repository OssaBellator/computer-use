import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BROWSER_043_COMPUTER_CAPABILITY_PROFILE,
  COMPUTER_TASK_RUNTIME_CAPABILITY_PROFILE,
  DESKTOP_UI_CAPABILITY_PROFILE,
  DOCUMENT_MODEL_CAPABILITY_PROFILE,
  FILESYSTEM_CAPABILITY_PROFILE,
  LOCAL_COMPUTE_CAPABILITY_PROFILE,
  PROCESS_CAPABILITY_PROFILE,
  REALTIME_MEDIA_GAME_CAPABILITY_PROFILE,
  REMOTE_SESSION_CAPABILITY_PROFILE,
  SYSTEM_DEVICE_CAPABILITY_PROFILE,
  TERMINAL_CAPABILITY_PROFILE,
  validateComputerUseCapabilityProfile,
  type ComputerUseCapabilityProfile,
} from '../src/computer/computerUseCapabilityProfiles.js';

const COMPONENT_PROFILES: readonly ComputerUseCapabilityProfile[] = [
  BROWSER_043_COMPUTER_CAPABILITY_PROFILE,
  COMPUTER_TASK_RUNTIME_CAPABILITY_PROFILE,
  FILESYSTEM_CAPABILITY_PROFILE,
  PROCESS_CAPABILITY_PROFILE,
  TERMINAL_CAPABILITY_PROFILE,
  LOCAL_COMPUTE_CAPABILITY_PROFILE,
  DESKTOP_UI_CAPABILITY_PROFILE,
  REMOTE_SESSION_CAPABILITY_PROFILE,
  SYSTEM_DEVICE_CAPABILITY_PROFILE,
  DOCUMENT_MODEL_CAPABILITY_PROFILE,
  REALTIME_MEDIA_GAME_CAPABILITY_PROFILE,
];

test('all built-in component profiles are structurally valid components', () => {
  for (const profile of COMPONENT_PROFILES) {
    assert.equal(profile.kind, 'component', profile.id);
    assert.deepEqual(validateComputerUseCapabilityProfile(profile), [], profile.id);
  }
});

test('built-in component profile ids are unique', () => {
  const ids = COMPONENT_PROFILES.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
});

test('component capability states never contain duplicate scopes', () => {
  for (const profile of COMPONENT_PROFILES) {
    for (const [capability, state] of Object.entries(profile.capabilities)) {
      assert.ok(state, `${profile.id}:${capability}`);
      assert.equal(new Set(state.scopes).size, state.scopes.length, `${profile.id}:${capability}`);
    }
  }
});

test('backend contract profiles remain distinguishable from implemented adapters', () => {
  const backendProfiles = [
    DESKTOP_UI_CAPABILITY_PROFILE,
    REMOTE_SESSION_CAPABILITY_PROFILE,
    SYSTEM_DEVICE_CAPABILITY_PROFILE,
  ];

  for (const profile of backendProfiles) {
    const statuses = Object.values(profile.capabilities).flatMap((state) => state ? [state.status] : []);
    assert.ok(statuses.includes('backend-required'), profile.id);
    assert.ok(!statuses.includes('implemented'), profile.id);
  }
});
