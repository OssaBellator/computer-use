import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionModel } from '../src/model/interactionModel.js';
import type { InteractionNode } from '../src/types.js';

const node = (id: string, x: number, confidence = 1): InteractionNode => ({
  id,
  frameId: 'main',
  focused: false,
  disabled: false,
  rect: { x, y: 0, width: 20, height: 20 },
  visibleRect: { x, y: 0, width: 20, height: 20 },
  focusable: true,
  clickable: true,
  editable: false,
  scrollable: false,
  capabilities: ['focus', 'activate'],
  interactionConfidence: confidence,
});

test('model preserves learned focus topology across volatile snapshot refreshes', () => {
  const model = new InteractionModel();
  model.refresh([node('a', 0), node('b', 100)]);
  model.focusTopology.observe({ fromId: 'a', toId: 'b', direction: 'forward', observedAtMs: 1 });
  model.refresh([node('a', 10), node('b', 110)]);
  assert.equal(model.focusTopology.mostLikelyNext('a', 'forward'), 'b');
  assert.equal(model.getNode('a')?.rect?.x, 10);
});

test('model can prefer well-observed focus route over uncertain pointer target', () => {
  const model = new InteractionModel();
  model.refresh([node('a', 0), node('b', 100), node('c', 200, 0.1)]);
  for (let i = 0; i < 20; i += 1) {
    model.focusTopology.observe({ fromId: 'a', toId: 'b', direction: 'forward', observedAtMs: i });
    model.focusTopology.observe({ fromId: 'b', toId: 'c', direction: 'forward', observedAtMs: i });
  }
  const plan = model.plan('a', 'c', { includeDirectional: false });
  assert.deepEqual(plan?.edges.map((edge) => edge.kind), ['focus-next', 'focus-next']);
});

test('model returns null plan after target disappears on refresh', () => {
  const model = new InteractionModel();
  model.refresh([node('a', 0), node('b', 100)]);
  assert.ok(model.plan('a', 'b'));
  model.refresh([node('a', 0)]);
  assert.equal(model.plan('a', 'b'), null);
});
