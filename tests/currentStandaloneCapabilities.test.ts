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
