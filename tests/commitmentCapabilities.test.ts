import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
} from '../src/capabilities/standaloneChromiumCapabilities.js';
import { assessWebTaskCategory } from '../src/capabilities/webTaskCapabilities.js';

test('current standalone profile keeps commerce runnable with partial bounded commitment verification', () => {
  assert.equal(CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE.id, 'standalone-chromium-0.41');
  const commerce = assessWebTaskCategory(
    CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
    'transactions-commerce',
  );

  assert.equal(commerce.runnable, true);
  assert.equal(commerce.fullySupported, false);
  assert.equal(
    commerce.requiredUnsupported.some(
      (entry) => entry.requirement.capability === 'commitment-detection',
    ),
    false,
  );
  assert.equal(
    commerce.requiredPartial.some(
      (entry) => entry.requirement.capability === 'commitment-detection',
    ),
    true,
  );
  assert.equal(
    commerce.requiredPartial.some(
      (entry) => entry.requirement.capability === 'external-side-effect-verification',
    ),
    true,
  );
});

test('process-trigger verification remains partial rather than overclaimed', () => {
  const automation = assessWebTaskCategory(
    CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
    'automation-process-triggering',
  );
  assert.equal(
    automation.requiredPartial.some(
      (entry) => entry.requirement.capability === 'process-trigger-verification',
    ),
    true,
  );
});
