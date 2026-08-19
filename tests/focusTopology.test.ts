import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusTopology } from '../src/focus/focusTopology.js';
import type { InteractionNode } from '../src/types.js';

const node = (id: string): InteractionNode => ({
  id,
  frameId: 'main',
  focused: false,
  disabled: false,
  focusable: true,
  clickable: true,
  editable: false,
  scrollable: false,
  capabilities: ['focus'],
  interactionConfidence: 1,
});

test('focus topology learns the most frequently observed transition', () => {
  const topology = new FocusTopology();
  topology.observe({ fromId: 'a', toId: 'b', direction: 'forward', observedAtMs: 1 });
  topology.observe({ fromId: 'a', toId: 'c', direction: 'forward', observedAtMs: 2 });
  topology.observe({ fromId: 'a', toId: 'b', direction: 'forward', observedAtMs: 3 });
  assert.equal(topology.mostLikelyNext('a', 'forward'), 'b');
  assert.ok(topology.confidence('a', 'b', 'forward') > topology.confidence('a', 'c', 'forward'));
});

test('focus topology ignores self transitions and omits stale nodes from edges', () => {
  const topology = new FocusTopology();
  topology.observe({ fromId: 'a', toId: 'a', direction: 'forward' });
  topology.observe({ fromId: 'a', toId: 'b', direction: 'forward' });
  assert.equal(topology.toEdges([node('a')]).length, 0);
  assert.equal(topology.toEdges([node('a'), node('b')])[0].kind, 'focus-next');
});
