import test from 'node:test';
import assert from 'node:assert/strict';
import { viewportScrollDeltaToReveal } from '../src/geometry.js';
import { ScrollRevealController } from '../src/controller/scrollRevealController.js';
import { PointerController } from '../src/controller/pointerController.js';
import { VirtualTouchpad } from '../src/motor/virtualTouchpad.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { InteractionNode, Point } from '../src/types.js';

const node = (y: number): InteractionNode => ({
  id: 'target',
  frameId: 'main',
  focused: false,
  disabled: false,
  rect: { x: 10, y, width: 20, height: 20 },
  mainViewportRect: { x: 10, y, width: 20, height: 20 },
  mainViewportVisible: y >= 0 && y + 20 <= 100,
  focusable: true,
  clickable: true,
  editable: false,
  scrollable: false,
  capabilities: ['activate'],
  interactionConfidence: 1,
});

class Input implements BrowserInput {
  readonly scrolls: Point[] = [];
  readonly moves: Point[] = [];
  async movePointer(point: Point) { this.moves.push({ x: point.x, y: point.y }); }
  async pointerDown(_button: MouseButton = 'left') {}
  async pointerUp(_button: MouseButton = 'left') {}
  async pressKey(_key: string) {}
  async keyDown(_key: string) {}
  async keyUp(_key: string) {}
  async typeText(_text: string, _delayMs?: number) {}
  async scroll(delta: Point) { this.scrolls.push({ ...delta }); }
}

class Observer implements BrowserInteractionObserver {
  constructor(readonly snapshots: InteractionNode[][]) {}
  async snapshot() { return this.snapshots.shift() ?? []; }
  async targetPoint(_node: InteractionNode) { return null; }
  async pointStillTargets(_node: InteractionNode, _point: Point) { return false; }
  async viewportRect() { return { x: 0, y: 0, width: 100, height: 100 }; }
}

function nestedTarget(y: number, visible: boolean): InteractionNode {
  return {
    ...node(y),
    id: 'nested-target',
    structuralId: 'main:div:nth-of-type(1) > button:nth-of-type(1)',
    scrollAncestorStructuralId: 'main:div:nth-of-type(1)',
    mainViewportVisible: true,
    viewportVisible: visible,
    visibleRect: visible ? { x: 20, y, width: 20, height: 20 } : undefined,
  };
}

const scrollScope = (): InteractionNode => ({
  id: 'scope-stable',
  structuralId: 'main:div:nth-of-type(1)',
  frameId: 'main',
  name: 'Scroller',
  role: 'div',
  focused: false,
  disabled: false,
  rect: { x: 10, y: 10, width: 80, height: 80 },
  visibleRect: { x: 10, y: 10, width: 80, height: 80 },
  mainViewportRect: { x: 10, y: 10, width: 80, height: 80 },
  mainViewportVisibleRect: { x: 10, y: 10, width: 80, height: 80 },
  mainViewportVisible: true,
  viewportVisible: true,
  focusable: false,
  clickable: false,
  editable: false,
  scrollable: true,
  capabilities: ['scroll'],
  interactionConfidence: 1,
});

class NestedObserver implements BrowserInteractionObserver {
  revealed = false;
  snapshotCalls = 0;
  async snapshot() {
    this.snapshotCalls += 1;
    return [nestedTarget(this.revealed ? 50 : 150, this.revealed), scrollScope()];
  }
  async targetPoint(node: InteractionNode) {
    return node.id === 'scope-stable' ? { x: 50, y: 50 } : null;
  }
  async pointStillTargets(node: InteractionNode, point: Point) {
    return node.id === 'scope-stable' && point.x === 50 && point.y === 50;
  }
  async viewportRect() { return { x: 0, y: 0, width: 100, height: 100 }; }
}

class NestedInput extends Input {
  constructor(private readonly observer: NestedObserver) { super(); }
  override async scroll(delta: Point) {
    await super.scroll(delta);
    this.observer.revealed = true;
  }
}

test('viewport reveal geometry computes the minimal bottom correction', () => {
  assert.deepEqual(
    viewportScrollDeltaToReveal(
      { x: 10, y: 130, width: 20, height: 20 },
      { x: 0, y: 0, width: 100, height: 100 },
      10,
    ),
    { x: 0, y: 60 },
  );
});

test('scroll reveal observes the new geometry before reporting success', async () => {
  const input = new Input();
  const result = await new ScrollRevealController(
    new Observer([[node(130)], [node(70)]]),
    input,
  ).reveal(node(130), { marginPx: 10, maxSamples: 1, sleep: async () => {} });

  assert.equal(result.status, 'revealed');
  assert.deepEqual(input.scrolls, [{ x: 0, y: 60 }]);
  assert.equal(result.attempts, 1);
});

test('scroll reveal reports stalled when the target geometry does not move', async () => {
  const input = new Input();
  const result = await new ScrollRevealController(
    new Observer([[node(130)], [node(130)]]),
    input,
  ).reveal(node(130), { marginPx: 10, maxSamples: 1, sleep: async () => {} });

  assert.equal(result.status, 'stalled');
  assert.equal(result.attempts, 1);
});

test('nested reveal positions pointer over the scroll scope before wheel input', async () => {
  const observer = new NestedObserver();
  const input = new NestedInput(observer);
  const pointer = new PointerController(
    input,
    new VirtualTouchpad({ initialCursor: { x: 0, y: 0 } }),
    { sleep: async () => {}, sampleIntervalMs: 100 },
  );
  const result = await new ScrollRevealController(observer, input, pointer).reveal(
    nestedTarget(150, false),
    { marginPx: 10, maxSamples: 1, sleep: async () => {} },
  );

  assert.equal(result.status, 'revealed');
  assert.equal(result.scrollScopeId, 'scope-stable');
  assert.deepEqual(input.moves.at(-1), { x: 50, y: 50 });
  assert.deepEqual(input.scrolls, [{ x: 0, y: 90 }]);
  assert.equal(result.target?.viewportVisible, true);
});

test('nested reveal refuses blind wheel input when no pointer controller can address the scope', async () => {
  const observer = new NestedObserver();
  const input = new NestedInput(observer);
  const result = await new ScrollRevealController(observer, input).reveal(
    nestedTarget(150, false),
    { marginPx: 10, maxSamples: 1, sleep: async () => {} },
  );
  assert.equal(result.status, 'scroll-scope-unavailable');
  assert.deepEqual(input.scrolls, []);
});
