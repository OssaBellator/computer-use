import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForObservation } from '../src/verification/observationSettler.js';
import type { InteractionNode } from '../src/types.js';

const node = (id: string, value?: string): InteractionNode => ({
  id,
  frameId: 'main',
  focused: false,
  disabled: false,
  focusable: true,
  clickable: false,
  editable: value !== undefined,
  scrollable: false,
  capabilities: value !== undefined ? ['focus', 'type'] : ['focus'],
  interactionConfidence: 1,
  value,
});

test('observation settler polls through an unchanged snapshot and matches later change', async () => {
  const before = [node('input', 'a')];
  const snapshots = [
    [node('input', 'a')],
    [node('input', 'b')],
  ];
  const result = await waitForObservation(
    async () => snapshots.shift()!,
    before,
    undefined,
    { maxSamples: 2, sleep: async () => {} },
  );
  assert.equal(result.matched, true);
  assert.equal(result.samples, 2);
  assert.equal(result.delta.changedValues[0].after, 'b');
});

test('observation settler returns the latest state when its sample budget expires', async () => {
  const before = [node('input', 'a')];
  let calls = 0;
  const result = await waitForObservation(
    async () => {
      calls += 1;
      return [node('input', 'a')];
    },
    before,
    undefined,
    { maxSamples: 2, sleep: async () => {} },
  );
  assert.equal(result.matched, false);
  assert.equal(result.samples, 2);
  assert.equal(calls, 2);
  assert.deepEqual(result.after, [node('input', 'a')]);
});
