import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assessComputerUseCapabilityProfileTransition,
} from '../src/computer/computerUseCapabilityProfileTransitionAssessment.js';
import type { ComputerUseCapabilityProfile } from '../src/computer/computerUseCapabilityProfiles.js';

function profile(
  id: string,
  version: string,
  capabilities: ComputerUseCapabilityProfile['capabilities'],
): ComputerUseCapabilityProfile {
  return { id, version, kind: 'component', capabilities };
}

test('unchanged valid profiles produce an accepted empty transition', () => {
  const before = profile('fixture', '1.0', {
    'file-read': { status: 'implemented', scopes: ['filesystem'] },
  });
  const after = profile('fixture', '1.0', {
    'file-read': { status: 'implemented', scopes: ['filesystem'] },
  });

  const assessment = assessComputerUseCapabilityProfileTransition(before, after);
  assert.equal(assessment.accepted, true);
  assert.deepEqual(assessment.beforeValidationErrors, []);
  assert.deepEqual(assessment.afterValidationErrors, []);
  assert.deepEqual(assessment.deltas, []);
  assert.deepEqual(assessment.transitionErrors, []);
  assert.equal(assessment.beforeFingerprint, assessment.afterFingerprint);
});

test('semantic change under the same id and version fails revision discipline', () => {
  const before = profile('fixture', '1.0', {
    'file-read': { status: 'unsupported', scopes: ['filesystem'] },
  });
  const after = profile('fixture', '1.0', {
    'file-read': { status: 'implemented', scopes: ['filesystem'] },
  });

  const assessment = assessComputerUseCapabilityProfileTransition(before, after);
  assert.equal(assessment.accepted, false);
  assert.deepEqual(assessment.transitionErrors, [
    'profile.revision.changed-without-version-bump:fixture:1.0',
  ]);
  assert.equal(assessment.deltas[0]?.statusChange, 'promoted');
  assert.notEqual(assessment.beforeFingerprint, assessment.afterFingerprint);
});

test('version bump does not bypass high-risk promotion policy', () => {
  const before = profile('fixture', '1.0', {
    'file-delete': { status: 'unsupported', scopes: ['filesystem'] },
  });
  const after = profile('fixture', '1.1', {
    'file-delete': { status: 'partial', scopes: ['filesystem'] },
  });

  const assessment = assessComputerUseCapabilityProfileTransition(before, after);
  assert.equal(assessment.accepted, false);
  assert.deepEqual(assessment.transitionErrors, [
    'high-risk-capability.promotion:file-delete:unsupported->partial',
  ]);
});

test('explicit allowlist can accept a versioned high-risk promotion', () => {
  const before = profile('fixture', '1.0', {
    'system-settings': { status: 'backend-required', scopes: ['system-device'] },
  });
  const after = profile('fixture', '1.1', {
    'system-settings': { status: 'implemented', scopes: ['system-device'] },
  });

  const assessment = assessComputerUseCapabilityProfileTransition(before, after, {
    allowHighRiskPromotions: ['system-settings'],
  });
  assert.equal(assessment.accepted, true);
  assert.deepEqual(assessment.transitionErrors, []);
  assert.equal(assessment.deltas[0]?.highRisk, true);
  assert.equal(assessment.deltas[0]?.statusChange, 'promoted');
});

test('strict validation failures make an otherwise policy-neutral transition unacceptable', () => {
  const before = profile('fixture-before', '1.0', {
    'document-editing': { status: 'partial', scopes: ['browser'] },
  });
  const after = profile('fixture-after', '1.0', {
    'document-editing': { status: 'partial', scopes: ['browser', 'browser'] },
  });

  const assessment = assessComputerUseCapabilityProfileTransition(before, after);
  assert.equal(assessment.accepted, false);
  assert.deepEqual(assessment.beforeValidationErrors, []);
  assert.deepEqual(assessment.afterValidationErrors, [
    'capability.scope.duplicate:document-editing:browser',
  ]);
  assert.deepEqual(assessment.transitionErrors, []);
});
