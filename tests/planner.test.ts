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
