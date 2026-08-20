import assert from 'node:assert/strict';
import test from 'node:test';

import {
  diffComputerUseCapabilityProfiles,
  findHighRiskComputerCapabilityPromotions,
} from '../src/computer/computerUseCapabilityProfileDiff.js';
import type { ComputerUseCapabilityProfile } from '../src/computer/computerUseCapabilityProfiles.js';

function profile(
  id: string,
  capabilities: ComputerUseCapabilityProfile['capabilities'],
): ComputerUseCapabilityProfile {
  return { id, version: '1.0', kind: 'component', capabilities };
}

test('diff omits unchanged capabilities by default', () => {
  const before = profile('before', {
    'file-read': { status: 'implemented', scopes: ['filesystem'], note: 'bounded read' },
  });
  const after = profile('after', {
    'file-read': { status: 'implemented', scopes: ['filesystem'], note: 'bounded read' },
  });

  assert.deepEqual(diffComputerUseCapabilityProfiles(before, after), []);
});

test('diff reports status promotion and deterministic scope changes', () => {
  const before = profile('before', {
    'document-editing': {
      status: 'implemented-foundation',
      scopes: ['document-model'],
      note: 'semantic foundation',
    },
  });
  const after = profile('after', {
    'document-editing': {
      status: 'partial',
      scopes: ['browser', 'document-model'],
      note: 'browser implementation plus semantic foundation',
    },
  });

  assert.deepEqual(diffComputerUseCapabilityProfiles(before, after), [{
    capability: 'document-editing',
    highRisk: false,
    beforeStatus: 'implemented-foundation',
    afterStatus: 'partial',
    statusChange: 'promoted',
    addedScopes: ['browser'],
    removedScopes: [],
    noteChanged: true,
  }]);
});

test('scope-only changes are visible without being classified as support promotion', () => {
  const before = profile('before', {
    'terminal-execution': { status: 'implemented', scopes: ['terminal'] },
  });
  const after = profile('after', {
    'terminal-execution': { status: 'implemented', scopes: ['browser', 'terminal'] },
  });

  const [delta] = diffComputerUseCapabilityProfiles(before, after);
  assert.equal(delta?.statusChange, 'unchanged');
  assert.deepEqual(delta?.addedScopes, ['browser']);
  assert.deepEqual(delta?.removedScopes, []);
});

test('high-risk promotion detector finds destructive and privileged support widening', () => {
  const before = profile('before', {
    'file-delete': { status: 'unsupported', scopes: ['filesystem'] },
    'system-settings': { status: 'backend-required', scopes: ['system-device'] },
  });
  const after = profile('after', {
    'file-delete': { status: 'partial', scopes: ['filesystem'] },
    'system-settings': { status: 'implemented', scopes: ['system-device'] },
  });

  assert.deepEqual(
    findHighRiskComputerCapabilityPromotions(before, after).map((delta) => [
      delta.capability,
      delta.beforeStatus,
      delta.afterStatus,
    ]),
    [
      ['file-delete', 'unsupported', 'partial'],
      ['system-settings', 'backend-required', 'implemented'],
    ],
  );
});

test('high-risk demotions and unchanged states are not reported as promotions', () => {
  const before = profile('before', {
    'process-control': { status: 'partial', scopes: ['process'] },
    'device-settings': { status: 'backend-required', scopes: ['system-device'] },
  });
  const after = profile('after', {
    'process-control': { status: 'unsupported', scopes: ['process'] },
    'device-settings': { status: 'backend-required', scopes: ['system-device'] },
  });

  assert.deepEqual(findHighRiskComputerCapabilityPromotions(before, after), []);
});

test('includeUnchanged returns a complete taxonomy-ordered comparison', () => {
  const before = profile('before', {});
  const after = profile('after', {});
  const deltas = diffComputerUseCapabilityProfiles(before, after, { includeUnchanged: true });

  assert.ok(deltas.length > 0);
  assert.ok(deltas.every((delta) => delta.statusChange === 'unchanged'));
  assert.ok(deltas.every((delta) => delta.beforeStatus === 'unsupported'));
  assert.ok(deltas.every((delta) => delta.afterStatus === 'unsupported'));
});
