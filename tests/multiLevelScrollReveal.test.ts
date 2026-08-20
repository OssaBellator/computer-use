import test from 'node:test';
import assert from 'node:assert/strict';
import { ScrollRevealController } from '../src/controller/scrollRevealController.js';
import { PointerController } from '../src/controller/pointerController.js';
import { VirtualTouchpad } from '../src/motor/virtualTouchpad.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { InteractionNode, Point } from '../src/types.js';

function scrollNode(
  id: string,
  structuralId: string,
  rect: { x: number; y: number; width: number; height: number },
  viewportVisible: boolean,
  scrollAncestorStructuralId?: string,
): InteractionNode {
  return {
    id,
    structuralId,
    frameId: 'main',
    name: id,
    role: 'div',
    scrollAncestorStructuralId,
    focused: false,
    disabled: false,
    rect,
    visibleRect: viewportVisible ? rect : undefined,
    viewportVisible,
    mainViewportRect: rect,
    mainViewportVisibleRect: rect,
    mainViewportVisible: true,
    focusable: false,
    clickable: false,
    editable: false,
    scrollable: true,
    capabilities: ['scroll'],
    interactionConfidence: 1,
  };
}

class MultiLevelObserver implements BrowserInteractionObserver {
  outerScrolled = false;
  innerScrolled = false;

  private outer(): InteractionNode {
    return scrollNode(
      'outer-stable',
      'main:div:nth-of-type(1)',
      { x: 10, y: 10, width: 180, height: 180 },
      true,
    );
  }

  private inner(): InteractionNode {
    return scrollNode(
      'inner-stable',
      'main:div:nth-of-type(1) > div:nth-of-type(1)',
      this.outerScrolled
        ? { x: 40, y: 60, width: 120, height: 100 }
        : { x: 40, y: 250, width: 120, height: 100 },
      this.outerScrolled,
      'main:div:nth-of-type(1)',
    );
  }

  private target(): InteractionNode {
    const visible = this.outerScrolled && this.innerScrolled;
    return {
      id: 'target-stable',
      structuralId: 'main:div:nth-of-type(1) > div:nth-of-type(1) > button:nth-of-type(1)',
      frameId: 'main',
      name: 'Deep target',
      role: 'button',
      scrollAncestorStructuralId: 'main:div:nth-of-type(1) > div:nth-of-type(1)',
      focused: false,
      disabled: false,
      rect: this.innerScrolled
        ? { x: 60, y: 100, width: 60, height: 20 }
        : { x: 60, y: 220, width: 60, height: 20 },
      visibleRect: visible ? { x: 60, y: 100, width: 60, height: 20 } : undefined,
      viewportVisible: visible,
      mainViewportRect: this.innerScrolled
        ? { x: 60, y: 100, width: 60, height: 20 }
        : { x: 60, y: 220, width: 60, height: 20 },
      mainViewportVisible: true,
      focusable: true,
      clickable: true,
      editable: false,
      scrollable: false,
      capabilities: ['focus', 'activate'],
      interactionConfidence: 1,
    };
  }

  async snapshot() { return [this.outer(), this.inner(), this.target()]; }
  async targetPoint(node: InteractionNode) {
    if (node.id === 'outer-stable') return { x: 30, y: 30 };
    if (node.id === 'inner-stable' && this.outerScrolled) return { x: 80, y: 90 };
    return null;
  }
  async pointStillTargets(node: InteractionNode, point: Point) {
    if (node.id === 'outer-stable') return point.x === 30 && point.y === 30;
    if (node.id === 'inner-stable') return this.outerScrolled && point.x === 80 && point.y === 90;
    return false;
  }
  async viewportRect() { return { x: 0, y: 0, width: 200, height: 200 }; }
}

class MultiLevelInput implements BrowserInput {
  readonly moves: Point[] = [];
  readonly scrolls: Array<{ point: Point; delta: Point }> = [];
  private pointer: Point = { x: 0, y: 0 };
  constructor(private readonly observer: MultiLevelObserver) {}
  async movePointer(point: Point) {
    this.pointer = { ...point };
    this.moves.push({ ...point });
  }
  async pointerDown(_button: MouseButton = 'left') {}
  async pointerUp(_button: MouseButton = 'left') {}
  async pressKey(_key: string) {}
  async keyDown(_key: string) {}
  async keyUp(_key: string) {}
  async typeText(_text: string, _delayMs?: number) {}
  async scroll(delta: Point) {
    this.scrolls.push({ point: { ...this.pointer }, delta: { ...delta } });
    if (this.pointer.x === 30 && this.pointer.y === 30) this.observer.outerScrolled = true;
    if (this.pointer.x === 80 && this.pointer.y === 90) this.observer.innerScrolled = true;
  }
}

test('multi-level reveal scrolls outer scope before inner scope', async () => {
  const observer = new MultiLevelObserver();
  const input = new MultiLevelInput(observer);
  const pointer = new PointerController(
    input,
    new VirtualTouchpad({ initialCursor: { x: 0, y: 0 } }),
    { sleep: async () => {}, sampleIntervalMs: 100 },
  );
  const target = (await observer.snapshot()).find((node) => node.id === 'target-stable')!;

  const result = await new ScrollRevealController(observer, input, pointer).reveal(target, {
    marginPx: 10,
    maxSamples: 1,
    maxAttempts: 2,
    maxScopeDepth: 4,
    sleep: async () => {},
  });

  assert.equal(result.status, 'revealed');
  assert.deepEqual(result.scrollScopeChain, ['outer-stable', 'inner-stable']);
  assert.deepEqual(input.scrolls.map((entry) => entry.point), [
    { x: 30, y: 30 },
    { x: 80, y: 90 },
  ]);
  assert.equal(observer.outerScrolled, true);
  assert.equal(observer.innerScrolled, true);
  assert.equal(result.target?.viewportVisible, true);
  assert.equal(result.attempts, 2);
});

test('scope recursion fails closed on a structural cycle', async () => {
  const cyclic: InteractionNode = {
    id: 'cycle',
    structuralId: 'main:div:nth-of-type(1)',
    scrollAncestorStructuralId: 'main:div:nth-of-type(1)',
    frameId: 'main',
    focused: false,
    disabled: false,
    rect: { x: 0, y: 300, width: 50, height: 50 },
    mainViewportRect: { x: 0, y: 300, width: 50, height: 50 },
    mainViewportVisible: true,
    viewportVisible: false,
    focusable: false,
    clickable: false,
    editable: false,
    scrollable: true,
    capabilities: ['scroll'],
    interactionConfidence: 1,
  };
  const observer: BrowserInteractionObserver = {
    async snapshot() { return [cyclic]; },
    async targetPoint() { return null; },
    async pointStillTargets() { return false; },
    async viewportRect() { return { x: 0, y: 0, width: 100, height: 100 }; },
  };
  const input: BrowserInput = {
    async movePointer() {}, async pointerDown() {}, async pointerUp() {},
    async pressKey() {}, async keyDown() {}, async keyUp() {},
    async typeText() {}, async scroll() {},
  };
  const result = await new ScrollRevealController(observer, input).reveal(cyclic, {
    maxScopeDepth: 3,
    maxSamples: 1,
    sleep: async () => {},
  });
  assert.equal(result.status, 'scope-cycle');
});

test('scope recursion honors configured depth limit before wheel dispatch', async () => {
  const observer = new MultiLevelObserver();
  const input = new MultiLevelInput(observer);
  const target = (await observer.snapshot()).find((node) => node.id === 'target-stable')!;
  const result = await new ScrollRevealController(observer, input).reveal(target, {
    maxScopeDepth: 0,
    maxSamples: 1,
    sleep: async () => {},
  });
  assert.equal(result.status, 'scope-depth-exceeded');
  assert.deepEqual(input.scrolls, []);
});
