import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpInputAdapter } from '../src/input/cdpInputAdapter.js';
import type { CdpSessionLike } from '../src/browser/cdpIdentity.js';

test('CDP mouse adapter tracks pointer, button bitfield, and wheel origin', async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const session: CdpSessionLike = { async send(method, params) { calls.push({ method, params }); return {}; } };
  const input = new CdpInputAdapter(session);
  await input.movePointer({ x: 10, y: 20 });
  await input.pointerDown('left');
  await input.pointerUp('left');
  await input.scroll({ x: 0, y: 120 });
  assert.deepEqual(calls.map((call) => [call.method, call.params?.type, call.params?.buttons]), [
    ['Input.dispatchMouseEvent', 'mouseMoved', 0],
    ['Input.dispatchMouseEvent', 'mousePressed', 1],
    ['Input.dispatchMouseEvent', 'mouseReleased', 0],
    ['Input.dispatchMouseEvent', 'mouseWheel', 0],
  ]);
  assert.deepEqual([calls[3].params?.x, calls[3].params?.y], [10, 20]);
});

test('CDP key chord maintains modifier state through Tab and releases it', async () => {
  const events: Record<string, unknown>[] = [];
  const session: CdpSessionLike = { async send(method, params) {
    if (method === 'Input.dispatchKeyEvent') events.push(params ?? {});
    return {};
  } };
  await new CdpInputAdapter(session).pressKey('Shift+Tab');
  assert.deepEqual(events.map((event) => [event.type, event.key, event.modifiers]), [
    ['rawKeyDown', 'Shift', 8],
    ['rawKeyDown', 'Tab', 8],
    ['keyUp', 'Tab', 8],
    ['keyUp', 'Shift', 0],
  ]);
});

test('CDP text input dispatches exact printable text through key events', async () => {
  const events: Record<string, unknown>[] = [];
  const session: CdpSessionLike = { async send(method, params) {
    if (method === 'Input.dispatchKeyEvent') events.push(params ?? {});
    return {};
  } };
  await new CdpInputAdapter(session).typeText('a1');
  assert.deepEqual(events.filter((event) => event.type === 'keyDown').map((event) => event.text), ['a', '1']);
  assert.deepEqual(events.filter((event) => event.type === 'keyUp').map((event) => event.key), ['a', '1']);
});
