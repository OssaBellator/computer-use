import assert from 'node:assert/strict';
import test from 'node:test';

import { CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE } from '../src/capabilities/standaloneChromiumCapabilities.js';
import {
  BROWSER_043_COMPUTER_CAPABILITY_PROFILE,
  computerCapabilityImplementationState,
} from '../src/computer/computerUseCapabilityProfiles.js';

const NON_BROWSER_CAPABILITIES = [
  'filesystem-observation',
  'file-read',
  'file-write',
  'file-move-copy',
  'file-delete',
  'archive-compression',
  'backup-restore',
  'storage-partitioning',
  'process-observation',
  'process-launch',
  'process-control',
  'terminal-execution',
  'software-installation',
  'system-settings',
  'security-settings',
  'device-settings',
  'network-session',
  'remote-desktop',
  'ssh-session',
  'hardware-device-control',
  'local-compute',
  'model-execution',
] as const;

test('historical browser projection keeps non-browser computer capabilities unsupported', () => {
  for (const capability of NON_BROWSER_CAPABILITIES) {
    const state = computerCapabilityImplementationState(BROWSER_043_COMPUTER_CAPABILITY_PROFILE, capability);
    assert.equal(state.status, 'unsupported', capability);
    assert.deepEqual(state.scopes, ['browser'], capability);
  }
});

test('browser projection remains explicitly tied to historical 0.43 identity', () => {
  assert.equal(CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE.id, 'standalone-chromium-0.43');
  assert.equal(BROWSER_043_COMPUTER_CAPABILITY_PROFILE.id, 'computer-browser-projection-0.43');
  assert.equal(BROWSER_043_COMPUTER_CAPABILITY_PROFILE.version, '0.43');
});

test('browser-local computer capabilities preserve real historical support', () => {
  assert.equal(computerCapabilityImplementationState(BROWSER_043_COMPUTER_CAPABILITY_PROFILE, 'document-observation').status, 'implemented');
  assert.equal(computerCapabilityImplementationState(BROWSER_043_COMPUTER_CAPABILITY_PROFILE, 'document-editing').status, 'partial');
  assert.equal(computerCapabilityImplementationState(BROWSER_043_COMPUTER_CAPABILITY_PROFILE, 'game-control').status, 'partial');
});
