import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionGraph, bestDirectionalCandidate, directionalScore } from '../src/graph.js';
import type { InteractionNode } from '../src/types.js';

function node(id: string, x: number, y: number, confidence = 1): InteractionNode {
  return {
    id,
    frameId: 'main',
    focused: false,
    disabled: false,
    rect: { x, y, width: 20, height: 20 },
    focusable: true,
    clickable: true,
    editable: false,
    scrollable: false,
    capabilities: ['focus', 'activate'],
    interactionConfidence: confidence,
  };
}

test('directional navigation prefers alignment over diagonally closer candidates', () => {
  const origin = node('origin', 0, 0);
  assert.equal(
    bestDirectionalCandidate(origin, [node('diagonal', 55, 65), node('aligned', 100, 0)], 'right')?.id,
    'aligned',
  );
});

test('directional navigation rejects candidates in the opposite half-plane', () => {
  assert.equal(
    directionalScore(node('origin', 50, 50), node('left', 0, 50), 'right'),
    Number.POSITIVE_INFINITY,
  );
});

test('directional navigation penalizes lower-confidence candidates', () => {
  const origin = node('origin', 0, 0);
  assert.ok(
    directionalScore(origin, node('high', 100, 0, 1), 'right') <
      directionalScore(origin, node('low', 100, 0, 0.1), 'right'),
  );
});

test('graph chooses lowest weighted route rather than fewest edges', () => {
  const graph = new InteractionGraph();
  for (const n of [node('a', 0, 0), node('b', 10, 0), node('c', 20, 0)]) graph.upsertNode(n);
  graph.addEdge({ from: 'a', to: 'c', kind: 'pointer-move', estimatedTimeMs: 100, failureProbability: 0.8 });
  graph.addEdge({ from: 'a', to: 'b', kind: 'focus-next', estimatedTimeMs: 120 });
  graph.addEdge({ from: 'b', to: 'c', kind: 'activate', estimatedTimeMs: 120 });
  assert.deepEqual(graph.shortestPath('a', 'c')?.map((edge) => edge.to), ['b', 'c']);
});

test('graph returns null for unreachable and unknown targets', () => {
  const graph = new InteractionGraph();
  graph.upsertNode(node('a', 0, 0));
  graph.upsertNode(node('b', 10, 0));
  assert.equal(graph.shortestPath('a', 'b'), null);
  assert.equal(graph.shortestPath('a', 'missing'), null);
});
