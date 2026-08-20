import test from 'node:test';
import assert from 'node:assert/strict';
import { ActionExecutor, hasObservableChange } from '../src/controller/actionExecutor.js';
import { PointerController } from '../src/controller/pointerController.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import { VirtualTouchpad } from '../src/motor/virtualTouchpad.js';
import type { InteractionNode, Point } from '../src/types.js';

const node = (id: string, focused = false, value?: string): InteractionNode => ({
  id,
  frameId: 'main',
  focused,
  disabled: false,
  focusable: true,
  clickable: true,
  editable: value !== undefined,
  scrollable: false,
  capabilities: ['focus'],
  interactionConfidence: 1,
  value,
});

class RecordingInput implements BrowserInput {
  readonly typed: string[] = [];
  readonly scrolls: Point[] = [];
  readonly moves: Point[] = [];
  readonly buttons: string[] = [];
  async movePointer(point: Point): Promise<void> { this.moves.push({ ...point }); }
  async pointerDown(button: MouseButton = 'left'): Promise<void> { this.buttons.push(`down:${button}`); }
  async pointerUp(button: MouseButton = 'left'): Promise<void> { this.buttons.push(`up:${button}`); }
  async pressKey(_key: string): Promise<void> {}
  async keyDown(_key: string): Promise<void> {}
  async keyUp(_key: string): Promise<void> {}
  async typeText(text: string): Promise<void> { this.typed.push(text); }
  async scroll(delta: Point): Promise<void> { this.scrolls.push({ ...delta }); }
}

test('type action verifies expected value from observed snapshots', async () => {
  const input = new RecordingInput();
  const snapshots = [[node('input', true, 'a')], [node('input', true, 'abc')]];
  const pointer = new PointerController(input, new VirtualTouchpad(), { sleep: async () => {} });
  const executor = new ActionExecutor(input, pointer, async () => snapshots.shift()!);
  const result = await executor.typeText('bc', { targetId: 'input', expectedValue: 'abc' });
  assert.equal(result.verified, true);
  assert.deepEqual(input.typed, ['bc']);
  assert.equal(hasObservableChange(result.delta), true);
});

test('click result reports observation rather than assuming a state change', async () => {
  const input = new RecordingInput();
  const before = [node('button', false)];
  const snapshots = [before, before];
  const pointer = new PointerController(input, new VirtualTouchpad(), {
    sleep: async () => {},
    sampleIntervalMs: 100,
  });
  const executor = new ActionExecutor(input, pointer, async () => snapshots.shift()!);
  const result = await executor.click({ x: 5, y: 5 }, 10);
  assert.equal(hasObservableChange(result.delta), false);
  assert.deepEqual(input.buttons, ['down:left', 'up:left']);
});

test('scroll records requested delta and captures added nodes', async () => {
  const input = new RecordingInput();
  const snapshots = [[node('a')], [node('a'), node('b')]];
  const pointer = new PointerController(input, new VirtualTouchpad(), { sleep: async () => {} });
  const executor = new ActionExecutor(input, pointer, async () => snapshots.shift()!);
  const result = await executor.scroll({ x: 0, y: 400 });
  assert.deepEqual(input.scrolls, [{ x: 0, y: 400 }]);
  assert.deepEqual(result.delta.added, ['b']);
});
