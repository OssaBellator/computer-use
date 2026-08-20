import assert from 'node:assert/strict';
import test from 'node:test';

import { CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE } from '../src/capabilities/standaloneChromiumCapabilities.js';
import {
  CURRENT_COMPUTER_USE_CAPABILITY_PROFILE,
  DESKTOP_UI_CAPABILITY_PROFILE,
  FILESYSTEM_CAPABILITY_PROFILE,
  HIGH_RISK_COMPUTER_CAPABILITIES,
  LOCAL_COMPUTE_CAPABILITY_PROFILE,
  PROCESS_CAPABILITY_PROFILE,
  REMOTE_SESSION_CAPABILITY_PROFILE,
  SYSTEM_DEVICE_CAPABILITY_PROFILE,
  TERMINAL_CAPABILITY_PROFILE,
  composeComputerUseCapabilityProfiles,
  computerCapabilityImplementationState,
  validateComputerUseCapabilityProfile,
  type ComputerUseCapabilityProfile,
} from '../src/computer/computerUseCapabilityProfiles.js';
import { COMPUTER_USE_CORE_CAPABILITY_PROFILE } from '../src/computer/profileComposition.js';

function supportOfBrowser(capability: keyof typeof CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE.capabilities): string {
  const value = CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE.capabilities[capability];
  return typeof value === 'string' ? value : value?.support ?? 'unsupported';
}

test('historical standalone Chromium 0.43 profile remains stable and browser-scoped', () => {
  assert.equal(CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE.id, 'standalone-chromium-0.43');
  assert.equal(supportOfBrowser('document-content-observation'), 'supported');
  assert.equal(supportOfBrowser('rich-text-editing'), 'partial');
  assert.equal(supportOfBrowser('long-running-task-checkpointing'), 'partial');
  assert.equal(supportOfBrowser('realtime-control'), 'supported');
  assert.notEqual(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE.id, CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE.id);
});

test('integrated profile validates as complete with explicit high-risk states', () => {
  assert.deepEqual(
    validateComputerUseCapabilityProfile(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE, {
      requireComplete: true,
      requireExplicitHighRisk: true,
    }),
    [],
  );
  for (const capability of HIGH_RISK_COMPUTER_CAPABILITIES) {
    assert.ok(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE.capabilities[capability]);
  }
});

test('filesystem read is implemented without claiming filesystem mutation', () => {
  assert.equal(computerCapabilityImplementationState(FILESYSTEM_CAPABILITY_PROFILE, 'filesystem-observation').status, 'implemented');
  assert.equal(computerCapabilityImplementationState(FILESYSTEM_CAPABILITY_PROFILE, 'file-read').status, 'implemented');
  assert.equal(computerCapabilityImplementationState(FILESYSTEM_CAPABILITY_PROFILE, 'file-write').status, 'unsupported');
  assert.equal(computerCapabilityImplementationState(FILESYSTEM_CAPABILITY_PROFILE, 'file-delete').status, 'unsupported');
});

test('process observation does not imply lifecycle control and terminal execution stays distinct', () => {
  assert.equal(computerCapabilityImplementationState(PROCESS_CAPABILITY_PROFILE, 'process-observation').status, 'implemented');
  assert.equal(computerCapabilityImplementationState(PROCESS_CAPABILITY_PROFILE, 'process-launch').status, 'unsupported');
  assert.equal(computerCapabilityImplementationState(PROCESS_CAPABILITY_PROFILE, 'process-control').status, 'unsupported');
  assert.equal(computerCapabilityImplementationState(TERMINAL_CAPABILITY_PROFILE, 'terminal-execution').status, 'implemented');
  assert.equal(computerCapabilityImplementationState(TERMINAL_CAPABILITY_PROFILE, 'local-compute').status, 'unsupported');
  assert.equal(computerCapabilityImplementationState(LOCAL_COMPUTE_CAPABILITY_PROFILE, 'local-compute').status, 'implemented');
  assert.match(computerCapabilityImplementationState(LOCAL_COMPUTE_CAPABILITY_PROFILE, 'local-compute').note ?? '', /cooperative/u);
});

test('backend contracts are not promoted to production support', () => {
  assert.equal(computerCapabilityImplementationState(DESKTOP_UI_CAPABILITY_PROFILE, 'semantic-ui-observation').status, 'backend-required');
  assert.equal(computerCapabilityImplementationState(DESKTOP_UI_CAPABILITY_PROFILE, 'keyboard-input').status, 'backend-required');
  assert.equal(computerCapabilityImplementationState(REMOTE_SESSION_CAPABILITY_PROFILE, 'remote-desktop').status, 'backend-required');
  assert.equal(computerCapabilityImplementationState(REMOTE_SESSION_CAPABILITY_PROFILE, 'ssh-session').status, 'backend-required');
  assert.equal(computerCapabilityImplementationState(SYSTEM_DEVICE_CAPABILITY_PROFILE, 'system-settings').status, 'backend-required');
  assert.equal(computerCapabilityImplementationState(SYSTEM_DEVICE_CAPABILITY_PROFILE, 'storage-partitioning').status, 'unsupported');
});

test('remote dispatch and semantic document foundations do not overclaim application effects', () => {
  assert.equal(computerCapabilityImplementationState(REMOTE_SESSION_CAPABILITY_PROFILE, 'side-effect-verification').status, 'partial');
  assert.equal(computerCapabilityImplementationState(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE, 'spreadsheet-editing').status, 'unsupported');
  assert.equal(computerCapabilityImplementationState(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE, 'presentation-editing').status, 'unsupported');
  assert.equal(computerCapabilityImplementationState(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE, 'software-installation').status, 'unsupported');
  assert.equal(computerCapabilityImplementationState(CURRENT_COMPUTER_USE_CAPABILITY_PROFILE, 'storage-partitioning').status, 'unsupported');
});

test('composition chooses real implementations over foundations without erasing scope', () => {
  const foundation: ComputerUseCapabilityProfile = {
    id: 'test-foundation', version: '1.0', kind: 'component', capabilities: {
      'document-editing': { status: 'implemented-foundation', scopes: ['document-model'] },
      'remote-desktop': { status: 'backend-required', scopes: ['remote-session'] },
    },
  };
  const implementation: ComputerUseCapabilityProfile = {
    id: 'test-implementation', version: '1.0', kind: 'component', capabilities: {
      'document-editing': { status: 'partial', scopes: ['browser'] },
    },
  };
  const composed = composeComputerUseCapabilityProfiles('test-composed', '1.0', [foundation, implementation]);
  assert.equal(computerCapabilityImplementationState(composed, 'document-editing').status, 'partial');
  assert.deepEqual(computerCapabilityImplementationState(composed, 'document-editing').scopes, ['browser', 'document-model']);
  assert.equal(computerCapabilityImplementationState(composed, 'remote-desktop').status, 'backend-required');
});

test('legacy neutral core profile reflects integrated ComputerTaskRuntime checkpointing', () => {
  const checkpoint = COMPUTER_USE_CORE_CAPABILITY_PROFILE.capabilities['task-checkpointing'];
  const approval = COMPUTER_USE_CORE_CAPABILITY_PROFILE.capabilities['explicit-confirmation-gate'];
  assert.equal(typeof checkpoint === 'string' ? checkpoint : checkpoint?.support, 'supported');
  assert.equal(typeof approval === 'string' ? approval : approval?.support, 'supported');
});
