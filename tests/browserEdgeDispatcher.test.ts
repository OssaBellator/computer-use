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

function compositeOwner(activeStructuralId: string): InteractionNode {
  return {
    ...node('owner', true),
    structuralId: 'main:body > div:nth-of-type(1)',
    role: 'listbox',
    activeDescendantId: activeStructuralId.endsWith('(1)') ? 'o1' : 'o2',
    activeDescendantStructuralId: activeStructuralId,
  };
}

function option(id: string, index: number): InteractionNode {
  return {
    ...node(id),
    structuralId: `main:body > div:nth-of-type(1) > div:nth-of-type(${index})`,
    role: 'option',
    focusable: false,
    rect: { x: 20, y: 20 + index * 30, width: 80, height: 24 },
    mainViewportRect: { x: 20, y: 20 + index * 30, width: 80, height: 24 },
  };
}

class Input implements BrowserInput {
  keys: string[] = [];
  moves: Point[] = [];
  async movePointer(point: Point) { this.moves.push({ x: point.x, y: point.y }); }
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

test('state-anchor validates composite logical state without dispatching input', async () => {
  const input = new Input();
  const observer = new Observer();
  const active = option('o1-stable', 1);
  const owner = compositeOwner(active.structuralId!);
  observer.snapshots.push([owner, active]);
  const pointer = new PointerController(input, new VirtualTouchpad(), { sleep: async () => {} });
  const dispatcher = new BrowserEdgeDispatcher(input, pointer, observer);
  const result = await dispatcher.dispatch(
    { from: owner.id, to: active.id, kind: 'state-anchor', estimatedTimeMs: 0 },
    context(owner, active),
  );
  assert.equal(result.succeeded, true);
  assert.equal(result.arrivedNodeId, active.id);
  assert.deepEqual(input.keys, []);
  assert.deepEqual(input.moves, []);
});

test('Arrow navigation uses active descendant as logical arrival and learns option transition', async () => {
  const input = new Input();
  const observer = new Observer();
  const first = option('o1-stable', 1);
  const second = option('o2-stable', 2);
  const ownerAfter = compositeOwner(second.structuralId!);
  observer.snapshots.push([ownerAfter, first, second]);
  const pointer = new PointerController(input, new VirtualTouchpad(), { sleep: async () => {} });
  const dispatcher = new BrowserEdgeDispatcher(input, pointer, observer);
  const ctx = context(first, second);
  ctx.model.refresh([compositeOwner(first.structuralId!), first, second]);
  const result = await dispatcher.dispatch(
    { from: first.id, to: second.id, kind: 'spatial-down', estimatedTimeMs: 90 },
    ctx,
  );
  assert.deepEqual(input.keys, ['ArrowDown']);
  assert.equal(result.succeeded, true);
  assert.equal(result.arrivedNodeId, second.id);
  assert.equal(ctx.model.directionalTopology.mostLikelyNext(first.id, 'down'), second.id);
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
