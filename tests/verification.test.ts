import test from 'node:test';
import assert from 'node:assert/strict';
import { diffSnapshots, focusTransitionSucceeded, valueChangeSucceeded } from '../src/verification/actionVerifier.js';
import type { InteractionNode } from '../src/types.js';

const node = (id: string, focused = false, value?: string): InteractionNode => ({
  id,
  frameId: 'main',
  focused,
  disabled: false,
  focusable: true,
  clickable: true,
  editable: value !== undefined,
  scrollable: false,
  capabilities: ['focus'],
  interactionConfidence: 1,
  value,
});

test('snapshot diff captures focus, identity and value transitions', () => {
  const delta = diffSnapshots(
    [node('a', true), node('input', false, 'old'), node('gone')],
    [node('a'), node('input', true, 'new'), node('added')],
  );
  assert.deepEqual(delta.added, ['added']);
  assert.deepEqual(delta.removed, ['gone']);
  assert.equal(focusTransitionSucceeded(delta, 'input'), true);
  assert.equal(valueChangeSucceeded(delta, 'input', 'new'), true);
});
