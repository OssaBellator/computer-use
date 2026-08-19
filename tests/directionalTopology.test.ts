import test from 'node:test';
import assert from 'node:assert/strict';
import { DirectionalTopology } from '../src/focus/directionalTopology.js';
import {
  buildDirectionalEdges,
  DEFAULT_SPECULATIVE_DIRECTION_FAILURE,
} from '../src/graphBuilder.js';
import { InteractionModel } from '../src/model/interactionModel.js';
import type { InteractionNode } from '../src/types.js';

const node = (id: string, x: number, y = 0): InteractionNode => ({
  id,
  frameId: 'main',
  focused: false,
  disabled: false,
  rect: { x, y, width: 20, height: 20 },
  visibleRect: { x, y, width: 20, height: 20 },
  viewportVisible: true,
  focusable: true,
  clickable: true,
  editable: false,
  scrollable: false,
  capabilities: ['focus', 'activate'],
  interactionConfidence: 1,
});

test('geometric Arrow-key edges carry a conservative speculative prior', () => {
  const edges = buildDirectionalEdges([node('a', 0), node('b', 100)]);
  const right = edges.find((edge) => edge.from === 'a' && edge.kind === 'spatial-right');
  assert.ok(right);
  assert.equal(right.failureProbability, DEFAULT_SPECULATIVE_DIRECTION_FAILURE);
  assert.ok((right.uncertaintyCost ?? 0) >= 0.6);
});

test('directional topology promotes repeated browser-observed transitions', () => {
  const topology = new DirectionalTopology();
  topology.observe({ fromId: 'a', toId: 'b', direction: 'right', observedAtMs: 1 });
  topology.observe({ fromId: 'a', toId: 'c', direction: 'right', observedAtMs: 2 });
  topology.observe({ fromId: 'a', toId: 'b', direction: 'right', observedAtMs: 3 });
  assert.equal(topology.mostLikelyNext('a', 'right'), 'b');
  assert.ok(
    topology.confidence('a', 'b', 'right') >
      topology.confidence('a', 'c', 'right'),
  );
});

test('interaction model replaces a speculative directional slot with observed behavior', () => {
  const model = new InteractionModel();
  model.refresh([node('a', 0), node('b', 100), node('c', 140, 80)]);

  let right = model.edgesForTarget('b', { includePointer: false })
    .filter((edge) => edge.from === 'a' && edge.kind === 'spatial-right');
  assert.equal(right.length, 1);
  assert.equal(right[0].to, 'b');
  assert.equal(right[0].failureProbability, DEFAULT_SPECULATIVE_DIRECTION_FAILURE);

  model.directionalTopology.observe({
    fromId: 'a',
    toId: 'c',
    direction: 'right',
    observedAtMs: 1,
  });
  right = model.edgesForTarget('b', { includePointer: false })
    .filter((edge) => edge.from === 'a' && edge.kind === 'spatial-right');
  assert.equal(right.length, 1);
  assert.equal(right[0].to, 'c');
  assert.equal(right[0].failureProbability, 0.5);
});
