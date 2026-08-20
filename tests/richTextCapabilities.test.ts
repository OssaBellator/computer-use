import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
} from '../src/capabilities/standaloneChromiumCapabilities.js';
import {
  assessWebTaskCategory,
} from '../src/capabilities/webTaskCapabilities.js';

test('current standalone profile exposes rich text editing as partial, not complete', () => {
  const collaboration = assessWebTaskCategory(
    CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
    'communication-collaboration',
  );

  assert.equal(collaboration.runnable, true);
  assert.equal(collaboration.fullySupported, false);
  assert.equal(
    collaboration.requiredPartial.some(
      (entry) => entry.requirement.capability === 'rich-text-editing',
    ),
    true,
  );
  assert.equal(
    collaboration.preferredUnsupported.some(
      (entry) => entry.requirement.capability === 'clipboard-write',
    ),
    true,
  );
});
