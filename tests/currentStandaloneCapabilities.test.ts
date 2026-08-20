import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
} from '../src/capabilities/standaloneChromiumCapabilities.js';
import {
  STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
  assessWebTaskCategory,
  type BrowserCapabilityProfile,
  type BrowserTaskCapability,
  type CapabilitySupport,
} from '../src/capabilities/webTaskCapabilities.js';

function supportOf(
  profile: BrowserCapabilityProfile,
  capability: BrowserTaskCapability,
): CapabilitySupport {
  const state = profile.capabilities[capability];
  return typeof state === 'string' ? state : state?.support ?? 'unsupported';
}

test('current standalone profile promotes document reading without rewriting historical capability state', () => {
  const historical = assessWebTaskCategory(
    STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
    'information-retrieval-research',
  );
  const current = assessWebTaskCategory(
    CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
    'information-retrieval-research',
  );

  assert.equal(historical.runnable, false);
  assert.equal(
    historical.requiredUnsupported.some(
      (entry) => entry.requirement.capability === 'document-content-observation',
    ),
    true,
  );
  assert.equal(current.runnable, true);
  assert.equal(
    current.requiredUnsupported.some(
      (entry) => entry.requirement.capability === 'document-content-observation',
    ),
    false,
  );
  assert.equal(
    current.preferredPartial.some(
      (entry) => entry.requirement.capability === 'network-activity-observation',
    ),
    true,
  );
});

test('current standalone 0.43 profile reflects merged browser foundations conservatively', () => {
  const current = CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE;
  assert.equal(current.id, 'standalone-chromium-0.43');

  for (const capability of [
    'document-content-observation',
    'relative-pointer-input',
    'realtime-control',
  ] as const) {
    assert.equal(supportOf(current, capability), 'supported', capability);
  }

  for (const capability of [
    'rich-text-editing',
    'clipboard-read',
    'clipboard-write',
    'drag-drop',
    'media-playback-control',
    'fullscreen-control',
    'permissions-control',
    'commitment-detection',
    'external-side-effect-verification',
    'process-trigger-verification',
    'long-running-task-checkpointing',
  ] as const) {
    assert.equal(supportOf(current, capability), 'partial', capability);
  }
});

test('content creation becomes runnable through partial clipboard/editing foundations without being fully supported', () => {
  const assessment = assessWebTaskCategory(
    CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
    'content-creation-publishing',
  );

  assert.equal(assessment.runnable, true);
  assert.equal(assessment.fullySupported, false);
  const requiredPartial = new Set(
    assessment.requiredPartial.map((entry) => entry.requirement.capability),
  );
  for (const capability of [
    'rich-text-editing',
    'file-upload',
    'clipboard-read',
    'clipboard-write',
    'external-side-effect-verification',
  ] as const) {
    assert.equal(requiredPartial.has(capability), true, capability);
  }
  assert.equal(
    assessment.preferredPartial.some((entry) => entry.requirement.capability === 'drag-drop'),
    true,
  );
});

test('transactions remain runnable but partial under commitment/result verification', () => {
  const assessment = assessWebTaskCategory(
    CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
    'transactions-commerce',
  );
  assert.equal(assessment.runnable, true);
  assert.equal(assessment.fullySupported, false);
  assert.equal(
    assessment.requiredPartial.some((entry) => entry.requirement.capability === 'commitment-detection'),
    true,
  );
  assert.equal(
    assessment.requiredPartial.some((entry) => entry.requirement.capability === 'external-side-effect-verification'),
    true,
  );
});
