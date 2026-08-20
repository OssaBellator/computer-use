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

test('CDP relative pointer movement accumulates from the last successful absolute point', async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const session: CdpSessionLike = { async send(method, params) { calls.push({ method, params }); return {}; } };
  const input = new CdpInputAdapter(session);
  await input.movePointer({ x: 100, y: 80 });
  await input.movePointerBy({ x: 12, y: -5 });
  await input.pointerDown('left');

  assert.deepEqual(
    calls.map((call) => [call.params?.type, call.params?.x, call.params?.y, call.params?.buttons]),
    [
      ['mouseMoved', 100, 80, 0],
      ['mouseMoved', 112, 75, 0],
      ['mousePressed', 112, 75, 1],
    ],
  );
});

test('CDP pointer movement rejects non-finite coordinates before dispatch', async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const session: CdpSessionLike = { async send(method, params) { calls.push({ method, params }); return {}; } };
  const input = new CdpInputAdapter(session);

  await assert.rejects(input.movePointerBy({ x: Number.NaN, y: 1 }), /must be finite/);
  assert.deepEqual(calls, []);
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

test('Ctrl+A suppresses printable text while the Control modifier is active', async () => {
  const events: Record<string, unknown>[] = [];
  const session: CdpSessionLike = { async send(method, params) {
    if (method === 'Input.dispatchKeyEvent') events.push(params ?? {});
    return {};
  } };
  await new CdpInputAdapter(session).pressKey('Control+a');
  assert.deepEqual(events.map((event) => [event.type, event.key, event.modifiers]), [
    ['rawKeyDown', 'Control', 2],
    ['rawKeyDown', 'a', 2],
    ['keyUp', 'a', 2],
    ['keyUp', 'Control', 0],
  ]);
  assert.equal('text' in events[1], false);
});

test('uppercase and shifted punctuation use coherent US-layout Shift metadata', async () => {
  const events: Record<string, unknown>[] = [];
  const session: CdpSessionLike = { async send(method, params) {
    if (method === 'Input.dispatchKeyEvent') events.push(params ?? {});
    return {};
  } };
  await new CdpInputAdapter(session).typeText('A!');
  const printable = events.filter((event) => event.type === 'keyDown');
  assert.deepEqual(
    printable.map((event) => [event.key, event.code, event.text, event.unmodifiedText, event.modifiers]),
    [
      ['A', 'KeyA', 'A', 'a', 8],
      ['!', 'Digit1', '!', '1', 8],
    ],
  );
  assert.equal(events.filter((event) => event.key === 'Shift' && event.type === 'rawKeyDown').length, 2);
  assert.equal(events.filter((event) => event.key === 'Shift' && event.type === 'keyUp').length, 2);
});

test('explicit Shift plus a base key resolves the shifted key value', async () => {
  const events: Record<string, unknown>[] = [];
  const session: CdpSessionLike = { async send(method, params) {
    if (method === 'Input.dispatchKeyEvent') events.push(params ?? {});
    return {};
  } };
  await new CdpInputAdapter(session).pressKey('Shift+1');
  const main = events.find((event) => event.type === 'keyDown' && event.code === 'Digit1');
  assert.ok(main);
  assert.deepEqual(
    [main.key, main.text, main.unmodifiedText, main.modifiers],
    ['!', '!', '1', 8],
  );
});
