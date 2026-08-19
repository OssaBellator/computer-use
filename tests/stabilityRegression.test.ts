import test from 'node:test';
import assert from 'node:assert/strict';
import { stabilizeInteractionNodeIds } from '../src/browser/cdpIdentity.js';
import { createPointerMoveEdge } from '../src/graphBuilder.js';
import { BrowserEdgeDispatcher } from '../src/controller/browserEdgeDispatcher.js';
import { PointerController } from '../src/controller/pointerController.js';
import { VirtualTouchpad } from '../src/motor/virtualTouchpad.js';
import { InteractionModel } from '../src/model/interactionModel.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { InteractionNode, Point } from '../src/types.js';

function node(id: string, x = 0): InteractionNode {
  return {
    id,
    frameId: 'main',
    focused: false,
    disabled: false,
    rect: { x, y: 0, width: 20, height: 20 },
    mainViewportRect: { x, y: 0, width: 20, height: 20 },
    mainViewportVisibleRect: { x, y: 0, width: 20, height: 20 },
    mainViewportVisible: true,
    viewportVisible: true,
    focusable: true,
    clickable: true,
    editable: false,
    scrollable: false,
    capabilities: ['focus', 'activate'],
    interactionConfidence: 1,
  };
}

test('backend-stable graph ID survives structural DOM reordering', () => {
  const before = stabilizeInteractionNodeIds([
    { ...node('main:body:nth-of-type(1) > button:nth-of-type(1)'), backendNodeId: 77 },
  ])[0];
  const after = stabilizeInteractionNodeIds([
    { ...node('main:body:nth-of-type(1) > button:nth-of-type(2)'), backendNodeId: 77 },
  ])[0];
  assert.equal(before.id, 'backend:77');
  assert.equal(after.id, 'backend:77');
  assert.notEqual(before.structuralId, after.structuralId);
});

test('pointer edge cost is derived from physical cursor when supplied', () => {
  const source = node('source', 900);
  const target = node('target', 100);
  const fromElementCenter = createPointerMoveEdge(source, target)!;
  const fromPhysicalCursor = createPointerMoveEdge(source, target, 4, { x: 90, y: 10 })!;
  assert.ok(fromPhysicalCursor.estimatedTimeMs < fromElementCenter.estimatedTimeMs);
});

class Input implements BrowserInput {
  moves: Point[] = [];
  async movePointer(point: Point) { this.moves.push({ ...point }); }
  async pointerDown(_button?: MouseButton) {}
  async pointerUp(_button?: MouseButton) {}
  async pressKey(_key: string) {}
  async keyDown(_key: string) {}
  async keyUp(_key: string) {}
  async typeText(_text: string, _delayMs?: number) {}
  async scroll(_delta: Point) {}
}

class Observer implements BrowserInteractionObserver {
  async snapshot() { return [node('source', 0), node('target', 100)]; }
  async targetPoint() { return { x: 110, y: 10 }; }
  async pointStillTargets() { return true; }
}

test('verified pointer dispatch feeds actual cursor position back into future planning', async () => {
  const input = new Input();
  const observer = new Observer();
  const model = new InteractionModel();
  const source = node('source', 0);
  const target = node('target', 100);
  model.refresh([source, target]);
  const pointer = new PointerController(
    input,
    new VirtualTouchpad({ initialCursor: { x: 0, y: 0 } }),
    { sleep: async () => {}, sampleIntervalMs: 100 },
  );
  const dispatcher = new BrowserEdgeDispatcher(input, pointer, observer);
  const result = await dispatcher.dispatch(
    { from: source.id, to: target.id, kind: 'pointer-move', estimatedTimeMs: 1 },
    { model, source, target },
  );
  assert.equal(result.succeeded, true);
  assert.deepEqual(model.getPointerPosition(), { x: 110, y: 10 });
});
