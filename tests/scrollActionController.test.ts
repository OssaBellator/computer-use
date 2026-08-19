import test from 'node:test';
import assert from 'node:assert/strict';
import { ScrollActionController } from '../src/controller/scrollActionController.js';
import { PointerController } from '../src/controller/pointerController.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import { VirtualTouchpad } from '../src/motor/virtualTouchpad.js';
import type { InteractionNode, Point, Rect } from '../src/types.js';

function node(id: string, y: number, overrides: Partial<InteractionNode> = {}): InteractionNode {
  return {
    id, frameId: 'main', role: 'button', name: id, focused: false, disabled: false,
    rect: { x: 250, y, width: 100, height: 40 },
    mainViewportRect: { x: 250, y, width: 100, height: 40 },
    viewportVisible: true, mainViewportVisible: true,
    focusable: true, clickable: true, editable: false, scrollable: false,
    capabilities: ['focus', 'activate'], interactionConfidence: 1,
    ...overrides,
  };
}

class Input implements BrowserInput {
  readonly moves: Point[] = [];
  readonly scrolls: Point[] = [];
  async movePointer(point: Point) { this.moves.push({ ...point }); }
  async pointerDown(_button: MouseButton = 'left') {}
  async pointerUp(_button: MouseButton = 'left') {}
  async pressKey(_key: string) {}
  async keyDown(_key: string) {}
  async keyUp(_key: string) {}
  async typeText(_text: string, _delayMs?: number) {}
  async scroll(delta: Point) { this.scrolls.push({ ...delta }); }
}

class Observer implements BrowserInteractionObserver {
  constructor(
    readonly snapshots: InteractionNode[][],
    readonly viewport: Rect = { x: 0, y: 0, width: 800, height: 600 },
  ) {}
  async snapshot() { return this.snapshots.shift() ?? []; }
  async targetPoint(_node: InteractionNode) { return null; }
  async pointStillTargets(_node: InteractionNode, _point: Point) { return false; }
  async viewportRect() { return { ...this.viewport }; }
}

function controller(observer: Observer, input: Input) {
  return new ScrollActionController(
    observer,
    input,
    new PointerController(input, new VirtualTouchpad(), {
      sleep: async () => {},
      sampleIntervalMs: 100,
    }),
  );
}

test('viewport scroll verifies geometry movement after safe wheel dispatch', async () => {
  const before = [node('item', 300)];
  const after = [node('item', 180)];
  const input = new Input();
  const result = await controller(new Observer([before, before, after]), input)
    .scroll({ x: 0, y: 120 }, { maxSamples: 1 });

  assert.equal(result.status, 'verified');
  assert.deepEqual(input.scrolls, [{ x: 0, y: 120 }]);
  assert.ok(result.anchor);
  assert.equal(result.before[0].mainViewportRect?.y, 300);
  assert.equal(result.after[0].mainViewportRect?.y, 180);
});

test('viewport scroll routes wheel input outside visible nested scroll scopes', async () => {
  const panel = node('panel', 0, {
    rect: { x: 0, y: 0, width: 500, height: 600 },
    mainViewportRect: { x: 0, y: 0, width: 500, height: 600 },
    scrollable: true,
    capabilities: ['scroll'],
    focusable: false,
    clickable: false,
  });
  const before = [panel, node('item', 300)];
  const after = [panel, node('item', 200)];
  const input = new Input();
  const result = await controller(new Observer([before, before, after]), input)
    .scroll({ x: 0, y: 100 }, { maxSamples: 1 });

  assert.equal(result.status, 'verified');
  assert.ok(result.anchor);
  assert.ok(result.anchor!.x > 500);
  assert.deepEqual(input.scrolls, [{ x: 0, y: 100 }]);
});

test('viewport scroll rejects zero and oversized commands before wheel dispatch', async () => {
  const before = [node('item', 300)];
  const input = new Input();
  const zero = await controller(new Observer([before]), input).scroll({ x: 0, y: 0 });
  assert.equal(zero.status, 'invalid-delta');
  const oversized = await controller(new Observer([before]), input).scroll({ x: 0, y: 5000 });
  assert.equal(oversized.status, 'invalid-delta');
  assert.deepEqual(input.scrolls, []);
});
