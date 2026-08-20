import test from 'node:test';
import assert from 'node:assert/strict';
import { ScrollRevealController } from '../src/controller/scrollRevealController.js';
import { chooseViewportWheelAnchor } from '../src/controller/scrollWheelRouting.js';
import { PointerController } from '../src/controller/pointerController.js';
import { VirtualTouchpad } from '../src/motor/virtualTouchpad.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { InteractionNode, Point, Rect } from '../src/types.js';

const viewport: Rect = { x: 0, y: 0, width: 100, height: 100 };

function scrollPanel(rect: Rect): InteractionNode {
  return {
    id: 'panel', structuralId: 'main:div:nth-of-type(1)', frameId: 'main',
    focused: false, disabled: false, rect, visibleRect: rect, viewportVisible: true,
    mainViewportRect: rect, mainViewportVisibleRect: rect, mainViewportVisible: true,
    focusable: false, clickable: false, editable: false, scrollable: true,
    capabilities: ['scroll'], interactionConfidence: 1,
  };
}

function target(y: number, visible: boolean): InteractionNode {
  const rect = { x: 10, y, width: 20, height: 20 };
  return {
    id: 'target', frameId: 'main', name: 'Target', role: 'button',
    focused: false, disabled: false, rect,
    visibleRect: visible ? rect : undefined, viewportVisible: visible,
    mainViewportRect: rect,
    mainViewportVisibleRect: visible ? rect : undefined,
    mainViewportVisible: visible,
    focusable: true, clickable: true, editable: false, scrollable: false,
    capabilities: ['focus', 'activate'], interactionConfidence: 1,
  };
}

test('viewport wheel anchor retains a safe preferred pointer location', () => {
  assert.deepEqual(
    chooseViewportWheelAnchor(viewport, [scrollPanel({ x: 0, y: 0, width: 40, height: 100 })], { x: 90, y: 50 }),
    { x: 90, y: 50 },
  );
});

test('viewport wheel anchor avoids visible independently scrollable rectangles', () => {
  const anchor = chooseViewportWheelAnchor(
    viewport,
    [scrollPanel({ x: 0, y: 0, width: 80, height: 100 })],
    { x: 50, y: 50 },
  );
  assert.ok(anchor);
  assert.ok(anchor.x > 80);
});

test('viewport wheel anchor fails closed when every candidate is covered', () => {
  assert.equal(chooseViewportWheelAnchor(viewport, [scrollPanel(viewport)], { x: 50, y: 50 }), null);
});

class RoutingObserver implements BrowserInteractionObserver {
  documentScrolled = false;
  panelScrolled = false;
  async snapshot() {
    return [
      scrollPanel({ x: 0, y: 0, width: 80, height: 100 }),
      target(this.documentScrolled ? 70 : 130, this.documentScrolled),
    ];
  }
  async targetPoint() { return null; }
  async pointStillTargets() { return false; }
  async viewportRect() { return viewport; }
}

class RoutingInput implements BrowserInput {
  pointer: Point = { x: 50, y: 50 };
  readonly scrollPoints: Point[] = [];
  constructor(private readonly observer: RoutingObserver) {}
  async movePointer(point: Point) { this.pointer = { ...point }; }
  async pointerDown(_button?: MouseButton) {}
  async pointerUp(_button?: MouseButton) {}
  async pressKey(_key: string) {}
  async keyDown(_key: string) {}
  async keyUp(_key: string) {}
  async typeText(_text: string, _delayMs?: number) {}
  async scroll(_delta: Point) {
    this.scrollPoints.push({ ...this.pointer });
    if (this.pointer.x <= 80) this.observer.panelScrolled = true;
    else this.observer.documentScrolled = true;
  }
}

test('top-level reveal relocates away from a scroll panel before wheel dispatch', async () => {
  const observer = new RoutingObserver();
  const input = new RoutingInput(observer);
  const pointer = new PointerController(
    input,
    new VirtualTouchpad({ initialCursor: { x: 50, y: 50 } }),
    { sleep: async () => {}, sampleIntervalMs: 100 },
  );
  const initialTarget = (await observer.snapshot()).find((node) => node.id === 'target')!;
  const result = await new ScrollRevealController(observer, input, pointer).reveal(initialTarget, {
    marginPx: 10,
    maxSamples: 1,
    sleep: async () => {},
  });
  assert.equal(result.status, 'revealed');
  assert.equal(observer.panelScrolled, false);
  assert.equal(observer.documentScrolled, true);
  assert.ok(input.scrollPoints[0].x > 80);
});
