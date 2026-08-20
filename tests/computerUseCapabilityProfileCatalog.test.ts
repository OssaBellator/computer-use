import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CURRENT_COMPUTER_USE_COMPONENT_PROFILES,
  CURRENT_COMPUTER_USE_PROFILE_CATALOG,
} from '../src/computer/computerUseCapabilityProfileCatalog.js';
import {
  CURRENT_COMPUTER_USE_CAPABILITY_PROFILE,
  composeComputerUseCapabilityProfiles,
  validateComputerUseCapabilityProfile,
} from '../src/computer/computerUseCapabilityProfiles.js';

test('catalog enumerates unique built-in component profile ids', () => {
  const ids = CURRENT_COMPUTER_USE_COMPONENT_PROFILES.map((profile) => profile.id);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes('computer-browser-projection-0.43'));
  assert.ok(ids.includes('computer-task-runtime-0.2'));
  assert.ok(ids.includes('filesystem-adapter-1.0'));
  assert.ok(ids.includes('desktop-ui-contract-1.0'));
  assert.ok(ids.includes('document-model-foundation-1.0'));
});

test('every catalog component remains structurally valid', () => {
  for (const profile of CURRENT_COMPUTER_USE_COMPONENT_PROFILES) {
    assert.equal(profile.kind, 'component');
    assert.deepEqual(validateComputerUseCapabilityProfile(profile), []);
  }
});

test('catalog recomposes exactly to the current integrated profile', () => {
  const recomposed = composeComputerUseCapabilityProfiles(
    CURRENT_COMPUTER_USE_CAPABILITY_PROFILE.id,
    CURRENT_COMPUTER_USE_CAPABILITY_PROFILE.version,
    CURRENT_COMPUTER_USE_COMPONENT_PROFILES,
  );

  assert.deepEqual(recomposed, CURRENT_COMPUTER_USE_CAPABILITY_PROFILE);
});

test('catalog integrated reference is the canonical current profile', () => {
  assert.equal(CURRENT_COMPUTER_USE_PROFILE_CATALOG.integrated, CURRENT_COMPUTER_USE_CAPABILITY_PROFILE);
  assert.equal(CURRENT_COMPUTER_USE_PROFILE_CATALOG.components, CURRENT_COMPUTER_USE_COMPONENT_PROFILES);
});
