import test from 'node:test';
import assert from 'node:assert/strict';
import { SemanticActionController } from '../src/controller/semanticActionController.js';
import { PointerController } from '../src/controller/pointerController.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import { VirtualTouchpad } from '../src/motor/virtualTouchpad.js';
import type { InteractionNode, Point } from '../src/types.js';

const node = (id: string, overrides: Partial<InteractionNode> = {}): InteractionNode => ({
  id,
  frameId: 'main',
  focused: false,
  disabled: false,
  rect: { x: 10, y: 10, width: 80, height: 30 },
  mainViewportRect: { x: 10, y: 10, width: 80, height: 30 },
  mainViewportVisible: true,
  focusable: true,
  clickable: true,
  editable: false,
  scrollable: false,
  capabilities: ['focus', 'activate'],
  interactionConfidence: 1,
  ...overrides,
});

class Input implements BrowserInput {
  readonly keys: string[] = [];
  readonly typed: string[] = [];
  readonly moves: Point[] = [];
  readonly buttons: string[] = [];
  async movePointer(point: Point) { this.moves.push({ x: point.x, y: point.y }); }
  async pointerDown(button: MouseButton = 'left') { this.buttons.push(`down:${button}`); }
  async pointerUp(button: MouseButton = 'left') { this.buttons.push(`up:${button}`); }
  async pressKey(key: string) { this.keys.push(key); }
  async keyDown(_key: string) {}
  async keyUp(_key: string) {}
  async typeText(text: string, _delayMs?: number) { this.typed.push(text); }
  async scroll(_delta: Point) {}
}

class Observer implements BrowserInteractionObserver {
  constructor(
    readonly snapshots: InteractionNode[][],
    readonly point: Point | null = { x: 30, y: 20 },
  ) {}
  async snapshot() { return this.snapshots.shift() ?? []; }
  async targetPoint(_node: InteractionNode) { return this.point; }
  async pointStillTargets(_node: InteractionNode, _point: Point) { return true; }
}

function controller(observer: Observer, input: Input) {
  return new SemanticActionController(
    observer,
    input,
    new PointerController(input, new VirtualTouchpad(), {
      sleep: async () => {},
      sampleIntervalMs: 100,
    }),
  );
}

test('activation does not treat focus-only movement as proof of activation', async () => {
  const before = [node('button')];
  const after = [node('button', { focused: true })];
  const input = new Input();
  const result = await controller(new Observer([before, after]), input)
    .activate(before[0], { method: 'keyboard', maxSamples: 1 });
  assert.equal(result.status, 'unverified');
  assert.deepEqual(input.keys, ['Enter']);
  assert.equal(result.before[0].id, 'button');
});

test('focused checkbox activation uses Space and verifies checked state', async () => {
  const before = [node('check', { focused: true, role: 'checkbox', checked: false })];
  const after = [node('check', { focused: true, role: 'checkbox', checked: true })];
  const input = new Input();
  const result = await controller(new Observer([before, after]), input)
    .activate(before[0], { maxSamples: 1 });
  assert.equal(result.status, 'verified');
  assert.deepEqual(input.keys, [' ']);
  assert.equal(result.delta.changedStates[0].field, 'checked');
});

test('pointer activation uses the observer-validated point and ordered click', async () => {
  const before = [node('button')];
  const after = [node('button', { expanded: true })];
  const input = new Input();
  const result = await controller(new Observer([before, after], { x: 40, y: 25 }), input)
    .activate(before[0], { method: 'pointer', maxSamples: 1 });
  assert.equal(result.verified, true);
  assert.deepEqual(input.moves.at(-1), { x: 40, y: 25 });
  assert.deepEqual(input.buttons, ['down:left', 'up:left']);
});

test('typeInto rejects non-editable targets without sending text', async () => {
  const before = [node('button')];
  const input = new Input();
  const result = await controller(new Observer([before]), input)
    .typeInto(before[0], 'x', { maxSamples: 1 });
  assert.equal(result.status, 'not-editable');
  assert.deepEqual(input.typed, []);
});

test('typeInto focuses an editable target by pointer then verifies expected value', async () => {
  const initial = node('input', {
    clickable: false,
    editable: true,
    capabilities: ['focus', 'type'],
    value: 'a',
  });
  const focused = { ...initial, focused: true };
  const typed = { ...focused, value: 'abc' };
  const input = new Input();
  const result = await controller(
    new Observer([[initial], [focused], [typed]], { x: 20, y: 20 }),
    input,
  ).typeInto(initial, 'bc', { expectedValue: 'abc', maxSamples: 1 });

  assert.equal(result.status, 'verified');
  assert.deepEqual(input.typed, ['bc']);
  assert.deepEqual(input.buttons, ['down:left', 'up:left']);
  assert.equal(result.before[0].focused, true);
  assert.equal(result.delta.changedValues[0].after, 'abc');
});
