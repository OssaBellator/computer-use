import test from 'node:test';
import assert from 'node:assert/strict';
import { CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE } from '../src/capabilities/standaloneChromiumCapabilities.js';
import {
  COMPUTER_TASK_CATEGORIES,
  COMPUTER_TASK_CATEGORY_DEFINITIONS,
  assessComputerTaskCategory,
  computerCapabilityState,
} from '../src/computer/computerCapabilities.js';
import { computerProfileFromBrowserProfile } from '../src/computer/browserCapabilityBridge.js';
import {
  computerActionMayAutoRetry,
  computerEffectRequiresApproval,
  sameComputerEntity,
  validateComputerEntityRef,
  validateComputerSurfaceRef,
  type ComputerEntityRef,
} from '../src/computer/environmentAdapter.js';

test('computer-use taxonomy defines exactly the seven broader task categories', () => {
  assert.equal(COMPUTER_TASK_CATEGORIES.length, 7);
  assert.deepEqual(Object.keys(COMPUTER_TASK_CATEGORY_DEFINITIONS).sort(), [...COMPUTER_TASK_CATEGORIES].sort());
  for (const category of COMPUTER_TASK_CATEGORIES) {
    assert.ok(COMPUTER_TASK_CATEGORY_DEFINITIONS[category].label.length > 0);
    assert.ok(COMPUTER_TASK_CATEGORY_DEFINITIONS[category].examples.length > 0);
  }
});

test('environment identities are adapter-scoped, generation-aware, and bounded', () => {
  const entity: ComputerEntityRef = {
    adapterId: 'browser-primary',
    environment: 'browser',
    kind: 'ui-control',
    entityId: 'backend-node:42',
    surfaceId: 'target:abc',
    generation: 3,
  };
  assert.deepEqual(validateComputerEntityRef(entity), []);
  assert.equal(sameComputerEntity(entity, { ...entity }), true);
  assert.equal(sameComputerEntity(entity, { ...entity, generation: 4 }), false);
  assert.equal(sameComputerEntity(entity, { ...entity, adapterId: 'desktop-primary' }), false);
  assert.ok(validateComputerEntityRef({ ...entity, entityId: 'bad\nidentity' }).length > 0);
  assert.ok(validateComputerSurfaceRef({
    adapterId: 'desktop-primary', environment: 'desktop-ui', surfaceId: 'window:1', generation: -1,
  }).length > 0);
});

test('computer side-effect and retry rules remain fail-closed after dispatch', () => {
  assert.equal(computerEffectRequiresApproval('observe-only'), false);
  assert.equal(computerEffectRequiresApproval('local-reversible'), false);
  assert.equal(computerEffectRequiresApproval('local-destructive'), true);
  assert.equal(computerEffectRequiresApproval('security-sensitive'), true);
  assert.equal(computerEffectRequiresApproval('remote-execution'), true);
  assert.equal(computerEffectRequiresApproval('hardware-affecting'), true);

  assert.equal(computerActionMayAutoRetry(
    { effect: 'external-communication', idempotency: 'non-idempotent' },
    { dispatch: 'dispatched-once' },
  ), false);
  assert.equal(computerActionMayAutoRetry(
    { effect: 'external-communication', idempotency: 'non-idempotent' },
    { dispatch: 'not-dispatched' },
  ), true);
  assert.equal(computerActionMayAutoRetry(
    { effect: 'observe-only', idempotency: 'read-only' },
    { dispatch: 'unknown' },
  ), true);
  assert.equal(computerActionMayAutoRetry(
    { effect: 'system-configuration', idempotency: 'idempotent' },
    { dispatch: 'unknown' },
  ), false);
});

test('browser bridge preserves browser strengths without pretending to be a general computer adapter', () => {
  const profile = computerProfileFromBrowserProfile(CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE);
  assert.equal(profile.id, `computer-via-${CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE.id}`);
  assert.equal(computerCapabilityState(profile, 'semantic-ui-observation').support, 'supported');
  assert.equal(computerCapabilityState(profile, 'document-observation').support, 'supported');
  assert.equal(computerCapabilityState(profile, 'relative-pointer-input').support, 'supported');
  assert.equal(computerCapabilityState(profile, 'document-editing').support, 'partial');
  assert.equal(computerCapabilityState(profile, 'media-playback').support, 'partial');
  assert.equal(computerCapabilityState(profile, 'game-control').support, 'partial');
  assert.equal(computerCapabilityState(profile, 'communication-control').support, 'partial');

  for (const capability of [
    'filesystem-observation', 'file-read', 'file-write', 'terminal-execution', 'process-observation',
    'software-installation', 'system-settings', 'security-settings', 'remote-desktop', 'ssh-session',
    'hardware-device-control',
  ] as const) {
    assert.equal(computerCapabilityState(profile, capability).support, 'unsupported');
  }
});

test('browser bridge never invents partial communication or game control from an empty browser profile', () => {
  const profile = computerProfileFromBrowserProfile({ id: 'empty-browser', capabilities: {} });
  assert.equal(computerCapabilityState(profile, 'semantic-ui-observation').support, 'unsupported');
  assert.equal(computerCapabilityState(profile, 'communication-control').support, 'unsupported');
  assert.equal(computerCapabilityState(profile, 'game-control').support, 'unsupported');
  assert.equal(computerCapabilityState(profile, 'filesystem-observation').support, 'unsupported');
});

test('broad native-computer categories remain unsupported through the browser adapter alone', () => {
  const profile = computerProfileFromBrowserProfile(CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE);
  for (const category of [
    'data-processing-analytics',
    'file-storage-management',
    'system-administration-security',
    'communication-remote-access',
    'process-automation',
  ] as const) {
    const assessment = assessComputerTaskCategory(profile, category);
    assert.equal(assessment.runnable, false, category);
    assert.equal(assessment.fullySupported, false, category);
    assert.ok(assessment.requiredUnsupported.length > 0, category);
  }
});
