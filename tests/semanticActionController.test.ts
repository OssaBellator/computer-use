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
    readonly hitResults: boolean[] = [],
  ) {}
  async snapshot() { return this.snapshots.shift() ?? []; }
  async targetPoint(_node: InteractionNode) { return this.point; }
  async pointStillTargets(_node: InteractionNode, _point: Point) {
    return this.hitResults.length ? this.hitResults.shift()! : true;
  }
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

test('pointer activation re-baselines after travel and uses an ordered click', async () => {
  const before = [node('button')];
  const after = [node('button', { expanded: true })];
  const input = new Input();
  const result = await controller(
    new Observer([before, before, after], { x: 40, y: 25 }),
    input,
  ).activate(before[0], { method: 'pointer', maxSamples: 1 });
  assert.equal(result.verified, true);
  assert.deepEqual(input.moves.at(-1), { x: 40, y: 25 });
  assert.deepEqual(input.buttons, ['down:left', 'up:left']);
});

test('pointer activation aborts before mouse-down when target moved during cursor travel', async () => {
  const before = [node('button')];
  const input = new Input();
  const result = await controller(
    new Observer([before, before, before], { x: 40, y: 25 }, [false, false]),
    input,
  ).activate(before[0], { method: 'pointer', maxSamples: 1 });
  assert.equal(result.status, 'target-moved');
  assert.deepEqual(input.buttons, []);
  assert.equal(input.moves.length > 0, true);
});

test('hover verifies semantic overlay appearance without clicking', async () => {
  const target = node('trigger', { name: 'More options' });
  const before = [target];
  const after = [target, node('overlay', {
    role: 'menu', name: 'Hover menu', focusable: false, clickable: false,
    capabilities: [],
  })];
  const input = new Input();
  const result = await controller(
    new Observer([before, after], { x: 40, y: 25 }),
    input,
  ).hover(target, { maxSamples: 1 });

  assert.equal(result.status, 'verified');
  assert.equal(result.delta.added[0]?.id, 'overlay');
  assert.deepEqual(input.moves.at(-1), { x: 40, y: 25 });
  assert.deepEqual(input.buttons, []);
});

test('hover stays unverified when pointer movement produces no semantic evidence', async () => {
  const target = node('trigger');
  const before = [target];
  const input = new Input();
  const result = await controller(new Observer([before, before]), input)
    .hover(target, { maxSamples: 1 });

  assert.equal(result.status, 'unverified');
  assert.equal(input.moves.length > 0, true);
  assert.deepEqual(input.buttons, []);
});

test('hover fails before pointer movement when no live target point is available', async () => {
  const target = node('trigger');
  const before = [target];
  const input = new Input();
  const result = await controller(new Observer([before], null), input)
    .hover(target, { maxSamples: 1 });

  assert.equal(result.status, 'target-point-unavailable');
  assert.deepEqual(input.moves, []);
});

test('typeInto rejects non-editable targets without sending text', async () => {
  const before = [node('button')];
  const input = new Input();
  const result = await controller(new Observer([before]), input)
    .typeInto(before[0], 'x', { maxSamples: 1 });
  assert.equal(result.status, 'not-editable');
  assert.deepEqual(input.typed, []);
});

test('typeInto focuses an editable target by revalidated pointer click then verifies value', async () => {
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
    new Observer([[initial], [initial], [focused], [typed]], { x: 20, y: 20 }),
    input,
  ).typeInto(initial, 'bc', { expectedValue: 'abc', maxSamples: 1 });

  assert.equal(result.status, 'verified');
  assert.deepEqual(input.typed, ['bc']);
  assert.deepEqual(input.buttons, ['down:left', 'up:left']);
  assert.equal(result.before[0].focused, true);
  assert.equal(result.delta.changedValues[0].after, 'abc');
});
