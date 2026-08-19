import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserEdgeDispatcher } from '../src/controller/browserEdgeDispatcher.js';
import { PointerController } from '../src/controller/pointerController.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import { InteractionModel } from '../src/model/interactionModel.js';
import { edgeModality } from '../src/planner/actionPlanner.js';
import { VirtualTouchpad } from '../src/motor/virtualTouchpad.js';
import type { InteractionEdge, InteractionNode, Point } from '../src/types.js';

function node(id: string, frameId: string, parentFrameId?: string, focused = false): InteractionNode {
  return {
    id,
    frameId,
    parentFrameId,
    focused,
    disabled: false,
    focusable: true,
    clickable: true,
    editable: false,
    scrollable: false,
    capabilities: ['focus', 'activate'],
    interactionConfidence: 1,
  };
}

class Input implements BrowserInput {
  readonly keys: string[] = [];
  async movePointer(_point: Point) {}
  async pointerDown(_button?: MouseButton) {}
  async pointerUp(_button?: MouseButton) {}
  async pressKey(key: string) { this.keys.push(key); }
  async keyDown(_key: string) {}
  async keyUp(_key: string) {}
  async typeText(_text: string, _delayMs?: number) {}
  async scroll(_delta: Point) {}
}

class Observer implements BrowserInteractionObserver {
  constructor(readonly after: InteractionNode[]) {}
  async snapshot() { return this.after; }
  async targetPoint() { return null; }
  async pointStillTargets() { return false; }
}

test('enter-frame edge dispatches learned Tab and reinforces focus topology', async () => {
  const source = node('outside', 'frame-main', undefined, true);
  const target = node('inside', 'frame-child', 'frame-main', false);
  const after = [node('outside', 'frame-main'), node('inside', 'frame-child', 'frame-main', true)];
  const model = new InteractionModel();
  model.refresh([source, target]);
  const input = new Input();
  const dispatcher = new BrowserEdgeDispatcher(
    input,
    new PointerController(input, new VirtualTouchpad(), { sleep: async () => {} }),
    new Observer(after),
  );
  const edge: InteractionEdge = {
    from: source.id,
    to: target.id,
    kind: 'enter-frame',
    modality: 'keyboard',
    keyboardKey: 'Tab',
    estimatedTimeMs: 100,
  };

  const result = await dispatcher.dispatch(edge, { model, source, target });
  assert.equal(result.succeeded, true);
  assert.equal(result.arrivedNodeId, target.id);
  assert.deepEqual(input.keys, ['Tab']);
  const learned = model.focusTopology.toEdges([source, target]);
  assert.equal(learned[0].kind, 'enter-frame');
  assert.equal(learned[0].keyboardKey, 'Tab');
});

test('exit-frame backward edge dispatches Shift+Tab and remains keyboard modality', async () => {
  const source = node('inside', 'frame-child', 'frame-main', true);
  const target = node('outside', 'frame-main', undefined, false);
  const after = [node('inside', 'frame-child', 'frame-main'), node('outside', 'frame-main', undefined, true)];
  const model = new InteractionModel();
  model.refresh([source, target]);
  const input = new Input();
  const dispatcher = new BrowserEdgeDispatcher(
    input,
    new PointerController(input, new VirtualTouchpad(), { sleep: async () => {} }),
    new Observer(after),
  );
  const edge: InteractionEdge = {
    from: source.id,
    to: target.id,
    kind: 'exit-frame',
    keyboardKey: 'Shift+Tab',
    estimatedTimeMs: 100,
  };

  const result = await dispatcher.dispatch(edge, { model, source, target });
  assert.equal(result.succeeded, true);
  assert.deepEqual(input.keys, ['Shift+Tab']);
  assert.equal(edgeModality(edge), 'keyboard');
  const learned = model.focusTopology.toEdges([source, target]);
  assert.equal(learned[0].kind, 'exit-frame');
  assert.equal(learned[0].keyboardKey, 'Shift+Tab');
});

test('interaction model plans through explicit learned frame boundary edge', () => {
  const outside = node('outside', 'frame-main');
  const inside = node('inside', 'frame-child', 'frame-main');
  const model = new InteractionModel();
  model.refresh([outside, inside]);
  for (let i = 0; i < 8; i += 1) {
    model.focusTopology.observe({ fromId: outside.id, toId: inside.id, direction: 'forward', observedAtMs: i });
  }
  const plan = model.plan(outside.id, inside.id, {
    includePointer: false,
    includeDirectional: false,
  });
  assert.ok(plan);
  assert.equal(plan.edges.length, 1);
  assert.equal(plan.edges[0].kind, 'enter-frame');
  assert.equal(plan.edges[0].keyboardKey, 'Tab');
  assert.equal(plan.finalModality, 'keyboard');
});
