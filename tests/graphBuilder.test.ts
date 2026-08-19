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

test('roving composite geometry cannot escape to a visually closer outside control', () => {
  const owner = 'main:div:nth-of-type(1)';
  const current = {
    ...node('current-tab', 0, 0),
    role: 'tab',
    tabIndex: 0,
    compositeOwnerStructuralId: owner,
  };
  const next = {
    ...node('next-tab', 100, 0),
    role: 'tab',
    tabIndex: -1,
    focusable: false,
    capabilities: ['activate'] as InteractionNode['capabilities'],
    compositeOwnerStructuralId: owner,
  };
  const outside = node('outside-button', 30, 0);

  const edges = buildDirectionalEdges([current, next, outside]);
  const right = edges.find((edge) => edge.from === current.id && edge.kind === 'spatial-right');
  assert.equal(right?.to, next.id);
  assert.ok(!edges.some((edge) => edge.from === current.id && edge.to === outside.id));
});

test('ordinary directional space does not speculate into a roving composite', () => {
  const start = node('plain-start', 0, 0);
  const compositeMember = {
    ...node('menu-item', 30, 0),
    role: 'menuitem',
    tabIndex: -1,
    compositeOwnerStructuralId: 'main:nav:nth-of-type(1)',
  };
  const plainTarget = node('plain-target', 100, 0);

  const edges = buildDirectionalEdges([start, compositeMember, plainTarget]);
  const right = edges.find((edge) => edge.from === start.id && edge.kind === 'spatial-right');
  assert.equal(right?.to, plainTarget.id);
  assert.ok(!edges.some((edge) => edge.from === start.id && edge.to === compositeMember.id));
});

test('tabindex-negative non-clickable grid cells remain Arrow destinations inside their grid', () => {
  const owner = 'main:div:nth-of-type(1)';
  const gridCell = (id: string, x: number, tabIndex: number): InteractionNode => ({
    ...node(id, x, 0),
    role: 'gridcell',
    tabIndex,
    compositeOwnerStructuralId: owner,
    focusable: tabIndex >= 0,
    clickable: false,
    capabilities: tabIndex >= 0 ? ['focus'] : [],
  });
  const first = gridCell('grid-a', 0, 0);
  const second = gridCell('grid-b', 80, -1);

  const edges = buildDirectionalEdges([first, second]);
  assert.equal(
    edges.find((edge) => edge.from === first.id && edge.kind === 'spatial-right')?.to,
    second.id,
  );
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

test('pointer and spatial edges do not target explicitly offscreen nodes', () => {
  const visible = node('visible', 0, 0);
  const offscreen = { ...node('offscreen', 100, 0), viewportVisible: false };
  assert.equal(createPointerMoveEdge(visible, offscreen), null);
  const edges = buildDirectionalEdges([visible, offscreen]);
  assert.ok(!edges.some((edge) => edge.to === 'offscreen'));
});

test('pointer edges prefer normalized main-viewport geometry when available', () => {
  const from = { ...node('from-main', 0, 0), mainViewportVisible: true, mainViewportVisibleRect: { x: 200, y: 100, width: 20, height: 20 } };
  const to = { ...node('to-main', 10, 0), mainViewportVisible: true, mainViewportVisibleRect: { x: 400, y: 100, width: 20, height: 20 } };
  const normalized = createPointerMoveEdge(from, to)!;
  const local = createPointerMoveEdge(node('a-local', 0, 0), node('b-local', 10, 0))!;
  assert.ok(normalized.estimatedTimeMs > local.estimatedTimeMs);
});
