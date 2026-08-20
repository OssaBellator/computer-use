import test from 'node:test';
import assert from 'node:assert/strict';
import { captureCdpBrowserState } from '../src/browser/browserState.js';

test('captureCdpBrowserState normalizes top-level runtime state', async () => {
  const calls: Array<[string, unknown]> = [];
  const session = {
    async send(method: string, params?: Record<string, unknown>) {
      calls.push([method, params]);
      return {
        result: {
          value: {
            url: 'https://example.test/a',
            origin: 'https://example.test',
            title: 'A',
            readyState: 'complete',
            historyLength: 3,
            timeOrigin: 1000,
          },
        },
      };
    },
  };
  const state = await captureCdpBrowserState(session);
  assert.deepEqual(state, {
    url: 'https://example.test/a',
    origin: 'https://example.test',
    title: 'A',
    readyState: 'complete',
    historyLength: 3,
    timeOrigin: 1000,
  });
  assert.equal(calls[0][0], 'Runtime.evaluate');
});

test('captureCdpBrowserState fails closed on malformed runtime values', async () => {
  const session = { async send() { return { result: { value: { url: 42 } } }; } };
  await assert.rejects(() => captureCdpBrowserState(session), /malformed browser state/);
});
