import test from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE } from '../src/capabilities/standaloneChromiumCapabilities.js';
import { computerProfileFromBrowserProfile } from '../src/computer/browserCapabilityBridge.js';
import {
  computerCapabilityState,
  type ComputerCapabilityProfile,
} from '../src/computer/computerCapabilities.js';
import {
  COMPUTER_USE_CORE_CAPABILITY_PROFILE,
  composeComputerCapabilityProfiles,
} from '../src/computer/profileComposition.js';

const filesystemProfile: ComputerCapabilityProfile = {
  id: 'filesystem-readonly-fixture',
  capabilities: {
    'filesystem-observation': 'supported',
    'file-read': 'supported',
    'file-write': 'unsupported',
  },
};

test('profile composition lets one adapter add capabilities another adapter lacks', () => {
  const browser = computerProfileFromBrowserProfile(CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE);
  const combined = composeComputerCapabilityProfiles('computer-fixture', [
    COMPUTER_USE_CORE_CAPABILITY_PROFILE,
    browser,
    filesystemProfile,
  ]);

  assert.equal(computerCapabilityState(combined, 'adapter-routing').support, 'supported');
  assert.equal(computerCapabilityState(combined, 'semantic-ui-observation').support, 'supported');
  assert.equal(computerCapabilityState(combined, 'filesystem-observation').support, 'supported');
  assert.equal(computerCapabilityState(combined, 'file-read').support, 'supported');
  assert.equal(computerCapabilityState(combined, 'file-write').support, 'unsupported');
  assert.equal(computerCapabilityState(combined, 'terminal-execution').support, 'unsupported');
});

test('composition is deterministic and rejects empty input', () => {
  const browser = computerProfileFromBrowserProfile(CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE);
  const first = composeComputerCapabilityProfiles('combined', [filesystemProfile, browser, COMPUTER_USE_CORE_CAPABILITY_PROFILE]);
  const second = composeComputerCapabilityProfiles('combined', [filesystemProfile, browser, COMPUTER_USE_CORE_CAPABILITY_PROFILE]);
  assert.deepEqual(first, second);
  assert.throws(() => composeComputerCapabilityProfiles('empty', []));
  assert.throws(() => composeComputerCapabilityProfiles('   ', [browser]));
});
