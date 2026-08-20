import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffSnapshots,
  focusTransitionSucceeded,
  stateChangeSucceeded,
  valueChangeSucceeded,
} from '../src/verification/actionVerifier.js';
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

test('snapshot diff captures ARIA-style semantic state changes', () => {
  const before = node('menu');
  before.expanded = false;
  before.activeDescendantId = 'item-1';
  const after = node('menu');
  after.expanded = true;
  after.activeDescendantId = 'item-2';
  const delta = diffSnapshots([before], [after]);
  assert.equal(stateChangeSucceeded(delta, 'menu', 'expanded', true), true);
  assert.equal(stateChangeSucceeded(delta, 'menu', 'activeDescendantId', 'item-2'), true);
  assert.deepEqual(delta.changedStates.map((change) => change.field), [
    'expanded',
    'activeDescendantId',
  ]);
});
