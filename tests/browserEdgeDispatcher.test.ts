import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserEdgeDispatcher } from '../src/controller/browserEdgeDispatcher.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import { PointerController } from '../src/controller/pointerController.js';
import { VirtualTouchpad } from '../src/motor/virtualTouchpad.js';
import { InteractionModel } from '../src/model/interactionModel.js';
import type { InteractionEdge, InteractionNode, Point } from '../src/types.js';

const node = (id: string, focused = false, frameId = 'main'): InteractionNode => ({
  id, frameId, focused, disabled: false, rect: { x: 0, y: 0, width: 40, height: 20 },
  mainViewportRect: { x: 20, y: 20, width: 40, height: 20 }, mainViewportVisible: true,
  focusable: true, clickable: true, editable: false, scrollable: false,
  capabilities: ['focus', 'activate'], interactionConfidence: 1,
});

class Input implements BrowserInput {
  keys: string[] = [];
  moves: Point[] = [];
  async movePointer(point: Point) { this.moves.push({ ...point }); }
  async pointerDown(_button?: MouseButton) {}
  async pointerUp(_button?: MouseButton) {}
  async pressKey(key: string) { this.keys.push(key); }
  async keyDown(_key: string) {}
  async keyUp(_key: string) {}
  async typeText(_text: string, _delayMs?: number) {}
  async scroll(_delta: Point) {}
}

class Observer implements BrowserInteractionObserver {
  snapshots: InteractionNode[][] = [];
  point: Point | null = { x: 30, y: 30 };
  hit = true;
  async snapshot() { return this.snapshots.shift() ?? []; }
  async targetPoint() { return this.point; }
  async pointStillTargets() { return this.hit; }
}

function context(source: InteractionNode, target: InteractionNode) {
  const model = new InteractionModel();
  model.refresh([source, target]);
  return { model, source, target };
}

test('keyboard dispatcher verifies observed focus and learns unexpected transition', async () => {
  const input = new Input();
  const observer = new Observer();
  const source = node('a', true);
  const expected = node('b');
  const actual = node('c', true);
  observer.snapshots.push([node('a'), expected, actual]);
  const pointer = new PointerController(input, new VirtualTouchpad(), { sleep: async () => {} });
  const dispatcher = new BrowserEdgeDispatcher(input, pointer, observer);
  const ctx = context(source, expected);
  ctx.model.refresh([source, expected, actual]);
  const edge: InteractionEdge = { from: 'a', to: 'b', kind: 'focus-next', estimatedTimeMs: 1 };
  const result = await dispatcher.dispatch(edge, ctx);
  assert.deepEqual(input.keys, ['Tab']);
  assert.equal(result.succeeded, false);
  assert.equal(result.arrivedNodeId, 'c');
  assert.equal(ctx.model.focusTopology.mostLikelyNext('a', 'forward'), 'c');
});

test('pointer dispatcher moves to a validated point and verifies it after movement', async () => {
  const input = new Input();
  const observer = new Observer();
  const source = node('main-a');
  const target = node('frame-b', false, 'frame-1');
  const pointer = new PointerController(input, new VirtualTouchpad({ initialCursor: { x: 0, y: 0 } }), { sleep: async () => {} });
  const dispatcher = new BrowserEdgeDispatcher(input, pointer, observer);
  const edge: InteractionEdge = { from: source.id, to: target.id, kind: 'pointer-move', estimatedTimeMs: 1 };
  const result = await dispatcher.dispatch(edge, context(source, target));
  assert.equal(result.succeeded, true);
  assert.equal(result.arrivedNodeId, target.id);
  assert.deepEqual(input.moves.at(-1), { x: 30, y: 30 });
});

test('pointer dispatcher fails closed when no backend-validated point exists', async () => {
  const input = new Input();
  const observer = new Observer();
  observer.point = null;
  const source = node('a');
  const target = node('b');
  const pointer = new PointerController(input, new VirtualTouchpad(), { sleep: async () => {} });
  const result = await new BrowserEdgeDispatcher(input, pointer, observer).dispatch(
    { from: 'a', to: 'b', kind: 'pointer-move', estimatedTimeMs: 1 },
    context(source, target),
  );
  assert.equal(result.succeeded, false);
  assert.equal(input.moves.length, 0);
});
