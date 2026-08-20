import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPUTER_CAPABILITY_IMPLEMENTATION_STATUS_RANK,
  compareComputerCapabilityImplementationStatus,
  strongestComputerCapabilityImplementationStatus,
} from '../src/computer/computerCapabilityImplementationStatusOrdering.js';
import {
  COMPUTER_CAPABILITY_IMPLEMENTATION_STATUSES,
  composeComputerUseCapabilityProfiles,
  computerCapabilityImplementationState,
  type ComputerCapabilityImplementationStatus,
  type ComputerUseCapabilityProfile,
} from '../src/computer/computerUseCapabilityProfiles.js';

const EXPECTED_ORDER: readonly ComputerCapabilityImplementationStatus[] = [
  'unsupported',
  'backend-required',
  'implemented-foundation',
  'partial',
  'implemented',
];

function profile(
  id: string,
  status: ComputerCapabilityImplementationStatus,
): ComputerUseCapabilityProfile {
  return {
    id,
    version: '1.0',
    kind: 'component',
    capabilities: {
      'document-editing': {
        status,
        scopes: ['document-model'],
      },
    },
  };
}

test('shared implementation status ordering is explicit and complete', () => {
  assert.deepEqual(
    [...COMPUTER_CAPABILITY_IMPLEMENTATION_STATUSES].sort(),
    [...EXPECTED_ORDER].sort(),
  );
  assert.deepEqual(
    EXPECTED_ORDER.map((status) => [status, COMPUTER_CAPABILITY_IMPLEMENTATION_STATUS_RANK[status]]),
    [
      ['unsupported', 0],
      ['backend-required', 1],
      ['implemented-foundation', 2],
      ['partial', 3],
      ['implemented', 4],
    ],
  );
});

test('comparison and strongest helpers agree for every status pair', () => {
  for (const left of EXPECTED_ORDER) {
    for (const right of EXPECTED_ORDER) {
      const comparison = compareComputerCapabilityImplementationStatus(left, right);
      assert.equal(Math.sign(comparison), Math.sign(
        COMPUTER_CAPABILITY_IMPLEMENTATION_STATUS_RANK[left]
        - COMPUTER_CAPABILITY_IMPLEMENTATION_STATUS_RANK[right],
      ));
      assert.equal(
        strongestComputerCapabilityImplementationStatus(left, right),
        COMPUTER_CAPABILITY_IMPLEMENTATION_STATUS_RANK[left]
          >= COMPUTER_CAPABILITY_IMPLEMENTATION_STATUS_RANK[right]
          ? left
          : right,
      );
    }
  }
});

test('shared strongest-state ordering matches profile composition for every status pair', () => {
  for (const left of EXPECTED_ORDER) {
    for (const right of EXPECTED_ORDER) {
      const composed = composeComputerUseCapabilityProfiles(
        `fixture-${left}-${right}`,
        '1.0',
        [profile(`left-${left}`, left), profile(`right-${right}`, right)],
      );
      assert.equal(
        computerCapabilityImplementationState(composed, 'document-editing').status,
        strongestComputerCapabilityImplementationStatus(left, right),
        `${left} vs ${right}`,
      );
    }
  }
});
