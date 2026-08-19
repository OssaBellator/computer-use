import test from 'node:test';
import assert from 'node:assert/strict';
import { planInteractionPath } from '../src/planner/actionPlanner.js';
import type { InteractionEdge, InteractionNode } from '../src/types.js';

const node = (id: string, x = 0): InteractionNode => ({
  id,
  frameId: 'main',
  focused: false,
  disabled: false,
  rect: { x, y: 0, width: 10, height: 10 },
  focusable: true,
  clickable: true,
  editable: false,
  scrollable: false,
  capabilities: ['focus'],
  interactionConfidence: 1,
});

test('A star planner preserves weighted optimal path with zero heuristic', () => {
  const nodes = [node('a'), node('b'), node('c')];
  const edges: InteractionEdge[] = [
    { from: 'a', to: 'c', kind: 'pointer-move', estimatedTimeMs: 500 },
    { from: 'a', to: 'b', kind: 'focus-next', estimatedTimeMs: 100 },
    { from: 'b', to: 'c', kind: 'focus-next', estimatedTimeMs: 100 },
  ];
  const plan = planInteractionPath(nodes, edges, 'a', 'c');
  assert.deepEqual(plan?.edges.map((edge) => edge.to), ['b', 'c']);
  assert.equal(plan?.totalCost, 200);
});

test('planner ignores edges whose endpoint is absent', () => {
  const plan = planInteractionPath(
    [node('a'), node('b')],
    [{ from: 'a', to: 'ghost', kind: 'focus-next', estimatedTimeMs: 1 }],
    'a',
    'b',
  );
  assert.equal(plan, null);
});

test('planner charges dynamic modality switches from path history', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d')];
  const edges: InteractionEdge[] = [
    { from: 'a', to: 'b', kind: 'pointer-move', estimatedTimeMs: 100 },
    { from: 'b', to: 'd', kind: 'focus-next', estimatedTimeMs: 100 },
    { from: 'a', to: 'c', kind: 'pointer-move', estimatedTimeMs: 100 },
    { from: 'c', to: 'd', kind: 'pointer-move', estimatedTimeMs: 210 },
  ];
  const plan = planInteractionPath(nodes, edges, 'a', 'd');
  assert.deepEqual(plan?.edges.map((edge) => edge.to), ['c', 'd']);
  assert.equal(plan?.totalCost, 310);
  assert.equal(plan?.finalModality, 'pointer');
});

test('planner keeps distinct modality states for the same graph node', () => {
  const nodes = [node('a'), node('b'), node('c'), node('d')];
  const edges: InteractionEdge[] = [
    { from: 'a', to: 'b', kind: 'focus-next', estimatedTimeMs: 10 },
    { from: 'a', to: 'c', kind: 'pointer-move', estimatedTimeMs: 20 },
    { from: 'c', to: 'b', kind: 'pointer-move', estimatedTimeMs: 20 },
    { from: 'b', to: 'd', kind: 'pointer-move', estimatedTimeMs: 10 },
  ];
  const plan = planInteractionPath(nodes, edges, 'a', 'd', {
    weights: { failure: 0, modalitySwitch: 100, scroll: 0, uncertainty: 0 },
  });
  assert.deepEqual(plan?.edges.map((edge) => edge.to), ['c', 'b', 'd']);
  assert.equal(plan?.totalCost, 50);
});

test('explicit edge modality override wins over kind inference', () => {
  const nodes = [node('a'), node('b')];
  const plan = planInteractionPath(
    nodes,
    [{ from: 'a', to: 'b', kind: 'activate', modality: 'pointer', estimatedTimeMs: 10 }],
    'a',
    'b',
    {
      initialModality: 'keyboard',
      weights: { failure: 0, modalitySwitch: 50, scroll: 0, uncertainty: 0 },
    },
  );
  assert.equal(plan?.totalCost, 60);
  assert.equal(plan?.finalModality, 'pointer');
});
