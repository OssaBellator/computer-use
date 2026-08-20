import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE } from '../src/capabilities/standaloneChromiumCapabilities.js';
import {
  COMPUTER_CAPABILITY_IMPLEMENTATION_STATUSES,
  CURRENT_COMPUTER_USE_CAPABILITY_PROFILE,
} from '../src/computer/computerUseCapabilityProfiles.js';

const DOC_PATH = 'docs/computer-capability-profiles.md';

function documentation(): string {
  return readFileSync(DOC_PATH, 'utf8');
}

test('capability profile documentation names the live integrated and historical profiles', () => {
  const docs = documentation();

  assert.ok(docs.includes(`\`${CURRENT_COMPUTER_USE_CAPABILITY_PROFILE.id}\``));
  assert.ok(docs.includes(`\`${CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE.id}\``));
  assert.ok(docs.includes(`\`${CURRENT_COMPUTER_USE_CAPABILITY_PROFILE.version}\``));
});

test('documentation keeps the complete five-state implementation vocabulary', () => {
  const docs = documentation();

  for (const status of COMPUTER_CAPABILITY_IMPLEMENTATION_STATUSES) {
    assert.ok(docs.includes(`\`${status}\``), `missing documented implementation status: ${status}`);
  }
});

test('documentation does not regress to the old integrated 0.43 identity', () => {
  const docs = documentation();

  assert.equal(docs.includes('computer-use-integrated-0.43'), false);
  assert.ok(docs.includes('intentionally independent from the historical browser `0.43` version'));
});

test('documentation retains source-only and backend-boundary caveats', () => {
  const docs = documentation();

  assert.ok(docs.includes('describes current source behavior only'));
  assert.ok(docs.includes('production OS support'));
  assert.ok(docs.includes('not by itself proof of the remote application'));
  assert.ok(docs.includes('not hard isolation'));
});
