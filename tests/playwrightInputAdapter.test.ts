import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PlaywrightInputAdapter,
  type PlaywrightPageInputLike,
} from '../src/input/playwrightInputAdapter.js';

test('Playwright adapter maps BrowserInput operations onto page mouse and keyboard primitives', async () => {
  const calls: unknown[] = [];
  const page: PlaywrightPageInputLike = {
    mouse: {
      async move(x, y) { calls.push(['move', x, y]); },
      async down(options) { calls.push(['down', options]); },
      async up(options) { calls.push(['up', options]); },
      async wheel(x, y) { calls.push(['wheel', x, y]); },
    },
    keyboard: {
      async press(key) { calls.push(['press', key]); },
      async down(key) { calls.push(['keyDown', key]); },
      async up(key) { calls.push(['keyUp', key]); },
      async type(text, options) { calls.push(['type', text, options]); },
    },
  };

  const adapter = new PlaywrightInputAdapter(page);
  await adapter.movePointer({ x: 10, y: 20 });
  await adapter.pointerDown('right');
  await adapter.pointerUp('right');
  await adapter.pressKey('Tab');
  await adapter.keyDown('Shift');
  await adapter.keyUp('Shift');
  await adapter.typeText('abc', -10);
  await adapter.scroll({ x: 2, y: 300 });

  assert.deepEqual(calls, [
    ['move', 10, 20],
    ['down', { button: 'right' }],
    ['up', { button: 'right' }],
    ['press', 'Tab'],
    ['keyDown', 'Shift'],
    ['keyUp', 'Shift'],
    ['type', 'abc', { delay: 0 }],
    ['wheel', 2, 300],
  ]);
});
