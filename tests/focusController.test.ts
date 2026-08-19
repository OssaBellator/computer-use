import test from 'node:test';
import assert from 'node:assert/strict';
import { FocusController } from '../src/controller/focusController.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { InteractionNode, Point } from '../src/types.js';

const node = (id: string, focused: boolean): InteractionNode => ({
  id,
  frameId: 'main',
  focused,
  disabled: false,
  focusable: true,
  clickable: true,
  editable: false,
  scrollable: false,
  capabilities: ['focus'],
  interactionConfidence: 1,
});

class RecordingKeys implements BrowserInput {
  readonly keys: string[] = [];
  async pressKey(key: string): Promise<void> { this.keys.push(key); }
  async movePointer(_point: Point): Promise<void> {}
  async pointerDown(_button?: MouseButton): Promise<void> {}
  async pointerUp(_button?: MouseButton): Promise<void> {}
  async keyDown(_key: string): Promise<void> {}
  async keyUp(_key: string): Promise<void> {}
  async typeText(_text: string, _delayMs?: number): Promise<void> {}
  async scroll(_delta: Point): Promise<void> {}
}

test('focus controller executes Tab and records observed transition', async () => {
  const input = new RecordingKeys();
  const snapshots = [
    [node('a', true), node('b', false)],
    [node('a', false), node('b', true)],
  ];
  const controller = new FocusController(input, async () => snapshots.shift()!);
  const result = await controller.step('forward');
  assert.deepEqual(input.keys, ['Tab']);
  assert.equal(result.observation?.toId, 'b');
  assert.equal(controller.topology.mostLikelyNext('a', 'forward'), 'b');
});

test('focus controller uses Shift+Tab and ignores unchanged focus', async () => {
  const input = new RecordingKeys();
  const snapshots = [[node('a', true)], [node('a', true)]];
  const controller = new FocusController(input, async () => snapshots.shift()!);
  const result = await controller.step('backward');
  assert.deepEqual(input.keys, ['Shift+Tab']);
  assert.equal(result.observation, null);
});
