import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpNavigationController } from '../src/browser/navigationController.js';

function state(url: string, readyState: 'loading' | 'interactive' | 'complete') {
  return {
    result: {
      value: {
        url,
        origin: new URL(url).origin,
        title: 'T',
        readyState,
        historyLength: 2,
        timeOrigin: url.includes('next') || url.includes('destination') ? 2000 : 1000,
      },
    },
  };
}

test('navigation controller waits through transient runtime contexts until complete', async () => {
  const runtime = [
    state('https://example.test/start', 'complete'),
    { exceptionDetails: { text: 'Execution context was destroyed.' } },
    state('https://example.test/next', 'interactive'),
    state('https://example.test/next', 'complete'),
  ];
  const session = {
    async send(method: string) {
      if (method === 'Page.navigate') return { frameId: 'main', loaderId: 'loader' };
      return runtime.shift();
    },
  };
  const result = await new CdpNavigationController(session).navigate('https://example.test/next', {
    pollIntervalMs: 0,
    maxPolls: 5,
    timeoutMs: 1000,
  });
  assert.equal(result.status, 'navigated');
  assert.equal(result.after?.url, 'https://example.test/next');
  assert.equal(result.polls, 3);
});

test('navigation controller surfaces protocol errors and validates URL schemes', async () => {
  const session = {
    async send(method: string) {
      if (method === 'Runtime.evaluate') return state('about:blank', 'complete');
      return { frameId: 'main', errorText: 'net::ERR_NAME_NOT_RESOLVED' };
    },
  };
  const result = await new CdpNavigationController(session).navigate(
    'https://missing.invalid/',
    { maxPolls: 1 },
  );
  assert.equal(result.status, 'navigation-error');
  assert.equal(result.errorText, 'net::ERR_NAME_NOT_RESOLVED');
  await assert.rejects(
    () => new CdpNavigationController(session).navigate('javascript:alert(1)'),
    /Unsupported navigation URL scheme/,
  );
});

test('navigation controller does not mistake the old completed document for the new navigation', async () => {
  const runtime = [
    state('https://example.test/start', 'complete'),
    state('https://example.test/start', 'complete'),
    state('https://example.test/destination', 'complete'),
  ];
  const session = {
    async send(method: string) {
      if (method === 'Page.navigate') return { frameId: 'main', loaderId: 'loader-2' };
      return runtime.shift();
    },
  };
  const result = await new CdpNavigationController(session).navigate(
    'https://example.test/destination',
    { pollIntervalMs: 0, maxPolls: 3, timeoutMs: 1000 },
  );
  assert.equal(result.status, 'navigated');
  assert.equal(result.after?.url, 'https://example.test/destination');
  assert.equal(result.polls, 2);
});
