import test from 'node:test';
import assert from 'node:assert/strict';
import { buildDirectionalEdges, createPointerMoveEdge } from '../src/graphBuilder.js';
import type { InteractionNode } from '../src/types.js';

const node = (
  id: string,
  x: number,
  y: number,
  frameId = 'main',
  confidence = 1,
): InteractionNode => ({
  id,
  frameId,
  focused: false,
  disabled: false,
  rect: { x, y, width: 20, height: 20 },
  focusable: true,
  clickable: true,
  editable: false,
  scrollable: false,
  capabilities: ['focus', 'activate'],
  interactionConfidence: confidence,
});

test('directional edge builder stays within frame and picks aligned neighbor', () => {
  const nodes = [
    node('a', 0, 0),
    node('b', 100, 0),
    node('diag', 40, 80),
    node('other', 20, 0, 'frame-1'),
  ];
  const edges = buildDirectionalEdges(nodes);
  const right = edges.find((edge) => edge.from === 'a' && edge.kind === 'spatial-right');
  assert.equal(right?.to, 'b');
  assert.ok(!edges.some((edge) => edge.from === 'a' && edge.to === 'other'));
});

test('pointer edge uses target confidence as uncertainty and refuses cross-frame motion', () => {
  const a = node('a', 0, 0);
  const b = node('b', 100, 0, 'main', 0.5);
  const edge = createPointerMoveEdge(a, b);
  assert.ok(edge);
  assert.equal(edge.kind, 'pointer-move');
  assert.equal(edge.uncertaintyCost, 0.5);
  assert.ok(edge.estimatedTimeMs > 0);
  assert.equal(createPointerMoveEdge(a, node('x', 0, 0, 'frame-1')), null);
});
