import test from 'node:test';
import assert from 'node:assert/strict';
import { viewportScrollDeltaToReveal } from '../src/geometry.js';
import { ScrollRevealController } from '../src/controller/scrollRevealController.js';
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
  async movePointer(_point: Point) {}
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
