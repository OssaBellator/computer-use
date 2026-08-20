import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
} from '../src/capabilities/standaloneChromiumCapabilities.js';
import {
  STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
  assessWebTaskCategory,
} from '../src/capabilities/webTaskCapabilities.js';

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
  assert.equal(current.capabilities['document-content-observation']?.support, 'supported');
  assert.equal(current.capabilities['relative-pointer-input']?.support, 'supported');
  assert.equal(current.capabilities['realtime-control']?.support, 'supported');
  assert.equal(current.capabilities['rich-text-editing']?.support, 'partial');
  assert.equal(current.capabilities['media-playback-control']?.support, 'partial');
  assert.equal(current.capabilities['fullscreen-control']?.support, 'partial');
  assert.equal(current.capabilities['permissions-control']?.support, 'partial');
  assert.equal(current.capabilities['long-running-task-checkpointing']?.support, 'partial');
  assert.equal(current.capabilities['external-side-effect-verification']?.support, 'partial');
  assert.equal(current.capabilities['process-trigger-verification']?.support, 'partial');
  assert.equal(current.capabilities['clipboard-write'], 'unsupported');
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
