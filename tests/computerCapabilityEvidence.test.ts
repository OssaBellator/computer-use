import assert from 'node:assert/strict';
import test from 'node:test';

import { collectComputerCapabilityScopeEvidence } from '../src/computer/computerCapabilityEvidence.js';
import {
  BROWSER_043_COMPUTER_CAPABILITY_PROFILE,
  DOCUMENT_MODEL_CAPABILITY_PROFILE,
  LOCAL_COMPUTE_CAPABILITY_PROFILE,
  TERMINAL_CAPABILITY_PROFILE,
} from '../src/computer/computerUseCapabilityProfiles.js';

test('per-scope evidence keeps terminal implementation distinct from unsupported scopes', () => {
  const evidence = collectComputerCapabilityScopeEvidence('terminal-execution', [
    BROWSER_043_COMPUTER_CAPABILITY_PROFILE,
    TERMINAL_CAPABILITY_PROFILE,
    LOCAL_COMPUTE_CAPABILITY_PROFILE,
  ]);

  assert.deepEqual(
    evidence.map(({ scope, status }) => [scope, status]),
    [
      ['browser', 'unsupported'],
      ['local-compute', 'unsupported'],
      ['terminal', 'implemented'],
    ],
  );
});

test('per-scope evidence preserves browser partial support beside document foundations', () => {
  const evidence = collectComputerCapabilityScopeEvidence('document-editing', [
    BROWSER_043_COMPUTER_CAPABILITY_PROFILE,
    DOCUMENT_MODEL_CAPABILITY_PROFILE,
  ]);

  assert.deepEqual(
    evidence.map(({ scope, status }) => [scope, status]),
    [
      ['browser', 'partial'],
      ['document-model', 'implemented-foundation'],
    ],
  );
});

test('same-scope evidence chooses strongest state and retains provenance', () => {
  const evidence = collectComputerCapabilityScopeEvidence('document-editing', [
    {
      id: 'foundation-a', version: '1.0', kind: 'component', capabilities: {
        'document-editing': {
          status: 'implemented-foundation', scopes: ['document-model'], note: 'semantic foundation',
        },
      },
    },
    {
      id: 'partial-b', version: '1.0', kind: 'component', capabilities: {
        'document-editing': {
          status: 'partial', scopes: ['document-model'], note: 'bounded integration',
        },
      },
    },
  ]);

  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.scope, 'document-model');
  assert.equal(evidence[0]?.status, 'partial');
  assert.deepEqual(evidence[0]?.profileIds, ['foundation-a', 'partial-b']);
  assert.deepEqual(evidence[0]?.notes, ['bounded integration', 'semantic foundation']);
});
