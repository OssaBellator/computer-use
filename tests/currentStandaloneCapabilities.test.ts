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

test('current standalone 0.42 profile keeps merged foundations conservative', () => {
  const current = CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE;
  assert.equal(current.id, 'standalone-chromium-0.42');
  assert.equal(supportOf(current, 'document-content-observation'), 'supported');
  assert.equal(supportOf(current, 'relative-pointer-input'), 'supported');
  assert.equal(supportOf(current, 'realtime-control'), 'supported');
  assert.equal(supportOf(current, 'rich-text-editing'), 'partial');
  assert.equal(supportOf(current, 'media-playback-control'), 'partial');
  assert.equal(supportOf(current, 'fullscreen-control'), 'partial');
  assert.equal(supportOf(current, 'permissions-control'), 'partial');
  assert.equal(supportOf(current, 'long-running-task-checkpointing'), 'partial');
  assert.equal(supportOf(current, 'external-side-effect-verification'), 'partial');
  assert.equal(supportOf(current, 'process-trigger-verification'), 'partial');
  assert.equal(supportOf(current, 'clipboard-write'), 'unsupported');
});

test('content creation remains blocked by unsupported clipboard requirements', () => {
  const assessment = assessWebTaskCategory(
    CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
    'content-creation-publishing',
  );

  assert.equal(assessment.runnable, false);
  assert.equal(
    assessment.requiredUnsupported.some(
      (entry) => entry.requirement.capability === 'clipboard-read',
    ),
    true,
  );
  assert.equal(
    assessment.requiredUnsupported.some(
      (entry) => entry.requirement.capability === 'clipboard-write',
    ),
    true,
  );
});
