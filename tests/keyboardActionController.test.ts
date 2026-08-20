import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyboardActionController } from '../src/controller/keyboardActionController.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { InteractionNode, Point } from '../src/types.js';

function node(id: string, focused: boolean): InteractionNode {
  return { id, frameId: 'main', role: id === 'first' ? 'textbox' : 'button', name: id, focused, disabled: false, focusable: true, clickable: id !== 'first', editable: id === 'first', scrollable: false, capabilities: id === 'first' ? ['focus', 'type'] : ['focus', 'activate'], interactionConfidence: 1 };
}
class Input implements BrowserInput {
  readonly keys: string[] = [];
  async movePointer(_point: Point) {}
  async pointerDown(_button: MouseButton = 'left') {}
  async pointerUp(_button: MouseButton = 'left') {}
  async pressKey(key: string) { this.keys.push(key); }
  async keyDown(_key: string) {}
  async keyUp(_key: string) {}
  async typeText(_text: string, _delayMs?: number) {}
  async scroll(_delta: Point) {}
}
class Observer implements BrowserInteractionObserver {
  constructor(private readonly snapshots: InteractionNode[][]) {}
  async snapshot() { return this.snapshots.shift() ?? []; }
  async targetPoint() { return null; }
  async pointStillTargets() { return false; }
}

test('press-key verifies a semantic focus transition', async () => {
  const input = new Input();
  const before = [node('first', true), node('second', false)];
  const after = [node('first', false), node('second', true)];
  const result = await new KeyboardActionController(new Observer([before, after]), input).press('Tab', { maxSamples: 1 });
  assert.equal(result.status, 'verified');
  assert.equal(result.verified, true);
  assert.deepEqual(input.keys, ['Tab']);
  assert.equal(result.delta.focusedBefore, 'first');
  assert.equal(result.delta.focusedAfter, 'second');
});

test('press-key stays unverified when semantic state does not change', async () => {
  const input = new Input();
  const before = [node('first', true), node('second', false)];
  const result = await new KeyboardActionController(new Observer([before, before]), input).press('Escape', { maxSamples: 1 });
  assert.equal(result.status, 'unverified');
  assert.equal(result.verified, false);
  assert.deepEqual(input.keys, ['Escape']);
});

test('press-key rejects an empty key before browser input dispatch', async () => {
  const input = new Input();
  const controller = new KeyboardActionController(new Observer([[node('first', true)]]), input);
  await assert.rejects(() => controller.press('   '), /non-empty/);
  assert.deepEqual(input.keys, []);
});
