import assert from 'node:assert/strict';
import test from 'node:test';

import {
  validateComputerUseCapabilityProfileTransition,
} from '../src/computer/computerUseCapabilityProfileTransitionPolicy.js';
import type { ComputerUseCapabilityProfile } from '../src/computer/computerUseCapabilityProfiles.js';

function profile(
  id: string,
  capabilities: ComputerUseCapabilityProfile['capabilities'],
): ComputerUseCapabilityProfile {
  return { id, version: '1.0', kind: 'component', capabilities };
}

test('high-risk promotions are rejected by default', () => {
  const before = profile('before', {
    'file-delete': { status: 'unsupported', scopes: ['filesystem'] },
    'system-settings': { status: 'backend-required', scopes: ['system-device'] },
  });
  const after = profile('after', {
    'file-delete': { status: 'partial', scopes: ['filesystem'] },
    'system-settings': { status: 'implemented', scopes: ['system-device'] },
  });

  assert.deepEqual(validateComputerUseCapabilityProfileTransition(before, after), [
    'high-risk-capability.promotion:file-delete:unsupported->partial',
    'high-risk-capability.promotion:system-settings:backend-required->implemented',
  ]);
});

test('specific high-risk promotions require an explicit capability allowlist', () => {
  const before = profile('before', {
    'file-delete': { status: 'unsupported', scopes: ['filesystem'] },
    'system-settings': { status: 'backend-required', scopes: ['system-device'] },
  });
  const after = profile('after', {
    'file-delete': { status: 'partial', scopes: ['filesystem'] },
    'system-settings': { status: 'implemented', scopes: ['system-device'] },
  });

  assert.deepEqual(validateComputerUseCapabilityProfileTransition(before, after, {
    allowHighRiskPromotions: ['system-settings'],
  }), [
    'high-risk-capability.promotion:file-delete:unsupported->partial',
  ]);
});

test('non-high-risk promotions do not trip the high-risk transition policy', () => {
  const before = profile('before', {
    'file-read': { status: 'unsupported', scopes: ['filesystem'] },
    'document-editing': { status: 'implemented-foundation', scopes: ['document-model'] },
  });
  const after = profile('after', {
    'file-read': { status: 'implemented', scopes: ['filesystem'] },
    'document-editing': { status: 'partial', scopes: ['browser', 'document-model'] },
  });

  assert.deepEqual(validateComputerUseCapabilityProfileTransition(before, after), []);
});

test('high-risk demotions are allowed', () => {
  const before = profile('before', {
    'process-control': { status: 'partial', scopes: ['process'] },
  });
  const after = profile('after', {
    'process-control': { status: 'unsupported', scopes: ['process'] },
  });

  assert.deepEqual(validateComputerUseCapabilityProfileTransition(before, after), []);
});

test('scope and note changes alone do not count as high-risk support promotion', () => {
  const before = profile('before', {
    'security-settings': {
      status: 'backend-required',
      scopes: ['system-device'],
      note: 'production backend required',
    },
  });
  const after = profile('after', {
    'security-settings': {
      status: 'backend-required',
      scopes: ['browser', 'system-device'],
      note: 'broader provenance, same backend requirement',
    },
  });

  assert.deepEqual(validateComputerUseCapabilityProfileTransition(before, after), []);
});
