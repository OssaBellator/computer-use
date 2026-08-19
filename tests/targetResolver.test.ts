import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findInteractionTargets,
  resolveInteractionTarget,
  resolveInteractionTargetDetailed,
} from '../src/model/targetResolver.js';
import type { InteractionNode } from '../src/types.js';

const node = (id: string, name: string, confidence = 1): InteractionNode => ({
  id, frameId: 'main', name, role: 'button', focused: false, disabled: false,
  mainViewportRect: { x: 0, y: 0, width: 20, height: 20 }, mainViewportVisible: true,
  focusable: true, clickable: true, editable: false, scrollable: false,
  capabilities: ['focus', 'activate'], interactionConfidence: confidence,
});

test('resolver accepts stable IDs, structural IDs, exact names and substring queries', () => {
  const a = { ...node('backend:10', 'Save'), structuralId: 'main:body > button:nth-of-type(1)' };
  const nodes = [a, node('backend:20', 'Save draft')];
  assert.equal(resolveInteractionTarget(nodes, 'backend:10')?.id, 'backend:10');
  assert.equal(resolveInteractionTarget(nodes, 'main:body > button:nth-of-type(1)')?.id, 'backend:10');
  assert.equal(resolveInteractionTarget(nodes, 'Save')?.id, 'backend:10');
  assert.equal(resolveInteractionTarget(nodes, { nameIncludes: 'draft' })?.id, 'backend:20');
});

test('resolver ranks visible enabled high-confidence matches deterministically', () => {
  const hidden = { ...node('a', 'Go', 1), mainViewportVisible: false };
  const low = node('b', 'Go', 0.2);
  const high = node('c', 'Go', 0.9);
  assert.deepEqual(findInteractionTargets([hidden, low, high], { name: 'Go' }).map((item) => item.id), ['c', 'b', 'a']);
});

test('detailed resolution surfaces equally preferred semantic matches', () => {
  const first = node('backend:1', 'Delete', 0.9);
  const second = node('backend:2', 'Delete', 0.9);
  const resolution = resolveInteractionTargetDetailed([second, first], {
    name: 'Delete', role: 'button', visible: true, enabled: true,
  });
  assert.equal(resolution.target?.id, 'backend:1');
  assert.equal(resolution.ambiguous, true);
  assert.deepEqual(resolution.equallyPreferred.map((item) => item.id), ['backend:1', 'backend:2']);
});

test('detailed resolution is not ambiguous when semantic rank clearly prefers one match', () => {
  const resolution = resolveInteractionTargetDetailed([
    node('low', 'Open', 0.5),
    node('high', 'Open', 0.95),
  ], { name: 'Open' });
  assert.equal(resolution.target?.id, 'high');
  assert.equal(resolution.ambiguous, false);
  assert.deepEqual(resolution.equallyPreferred.map((item) => item.id), ['high']);
});
