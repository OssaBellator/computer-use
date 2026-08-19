import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildCompositeAnchorEdges,
  focusedCompositeState,
  resolveActiveDescendant,
} from '../src/focus/compositeState.js';
import { buildDirectionalEdges } from '../src/graphBuilder.js';
import { InteractionModel } from '../src/model/interactionModel.js';
import type { InteractionNode } from '../src/types.js';

function owner(activeStructuralId: string, focused = true): InteractionNode {
  return {
    id: 'owner-stable',
    structuralId: 'main:body > div:nth-of-type(1)',
    frameId: 'main',
    role: 'listbox',
    name: 'Choices',
    activeDescendantId: activeStructuralId.endsWith('(1)') ? 'one' : 'two',
    activeDescendantStructuralId: activeStructuralId,
    focused,
    disabled: false,
    rect: { x: 10, y: 10, width: 160, height: 100 },
    visibleRect: { x: 10, y: 10, width: 160, height: 100 },
    mainViewportRect: { x: 10, y: 10, width: 160, height: 100 },
    mainViewportVisible: true,
    viewportVisible: true,
    focusable: true,
    clickable: false,
    editable: false,
    scrollable: false,
    capabilities: ['focus'],
    interactionConfidence: 1,
  };
}

function option(id: string, index: number): InteractionNode {
  return {
    id,
    structuralId: `main:body > div:nth-of-type(1) > div:nth-of-type(${index})`,
    frameId: 'main',
    role: 'option',
    name: index === 1 ? 'One' : 'Two',
    focused: false,
    disabled: false,
    rect: { x: 20, y: 20 + (index - 1) * 40, width: 120, height: 30 },
    visibleRect: { x: 20, y: 20 + (index - 1) * 40, width: 120, height: 30 },
    mainViewportRect: { x: 20, y: 20 + (index - 1) * 40, width: 120, height: 30 },
    mainViewportVisible: true,
    viewportVisible: true,
    focusable: false,
    clickable: true,
    editable: false,
    scrollable: false,
    capabilities: ['activate'],
    interactionConfidence: 1,
  };
}

test('focused composite resolves active descendant by structural identity after stable IDs', () => {
  const first = option('backend:2', 1);
  const nodes = [owner(first.structuralId!), first, option('backend:3', 2)];
  assert.equal(resolveActiveDescendant(nodes, nodes[0])?.id, 'backend:2');
  assert.equal(focusedCompositeState(nodes)?.active.id, 'backend:2');
});

test('composite anchor edges are zero-input bridges in both directions', () => {
  const first = option('backend:2', 1);
  const nodes = [owner(first.structuralId!), first, option('backend:3', 2)];
  assert.deepEqual(
    buildCompositeAnchorEdges(nodes).map((edge) => [edge.from, edge.to, edge.kind, edge.estimatedTimeMs]),
    [
      ['owner-stable', 'backend:2', 'state-anchor', 0],
      ['backend:2', 'owner-stable', 'state-anchor', 0],
    ],
  );
});

test('unfocused composite does not expose active-descendant anchor state', () => {
  const first = option('backend:2', 1);
  const nodes = [owner(first.structuralId!, false), first];
  assert.equal(focusedCompositeState(nodes), null);
  assert.deepEqual(buildCompositeAnchorEdges(nodes), []);
});

test('active-descendant owner is not a speculative geometric Arrow source', () => {
  const first = option('backend:2', 1);
  const second = option('backend:3', 2);
  const nodes = [owner(first.structuralId!), first, second];
  const edges = buildDirectionalEdges(nodes);
  assert.equal(edges.some((edge) => edge.from === 'owner-stable'), false);
  assert.equal(
    edges.some((edge) => edge.from === first.id && edge.to === second.id && edge.kind === 'spatial-down'),
    true,
  );
});

test('model plans from real DOM focus into logical option space before Arrow navigation', () => {
  const first = option('backend:2', 1);
  const second = option('backend:3', 2);
  const listbox = owner(first.structuralId!);
  const model = new InteractionModel();
  model.refresh([listbox, first, second]);
  const plan = model.plan(listbox.id, second.id, {
    includePointer: false,
    includeDirectional: true,
  });
  assert.ok(plan);
  assert.deepEqual(plan.edges.map((edge) => edge.kind), ['state-anchor', 'spatial-down']);
  assert.deepEqual(plan.edges.map((edge) => edge.to), [first.id, second.id]);
});
