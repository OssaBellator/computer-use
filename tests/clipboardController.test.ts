import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpClipboardController } from '../src/browser/clipboardController.js';

test('clipboard write uses the browser API without user-gesture or permission elevation', async () => {
  const calls: Array<[string, Record<string, unknown> | undefined]> = [];
  const session = {
    async send(method: string, params?: Record<string, unknown>): Promise<any> {
      calls.push([method, params]);
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate') return { result: { objectId: 'global' } };
      if (method === 'Runtime.callFunctionOn') {
        assert.equal(params?.userGesture, undefined);
        assert.equal(String(params?.functionDeclaration).includes('navigator.clipboard'), true);
        return { result: { value: { status: 'written' } } };
      }
      if (method === 'Runtime.releaseObject') return {};
      throw new Error(`Unexpected ${method}`);
    },
  };

  const result = await new CdpClipboardController(session).write('main', {
    text: 'hello',
    html: '<strong>hello</strong>',
  });
  assert.deepEqual(result, {
    status: 'written', frameId: 'main', types: ['text/plain', 'text/html'], totalBytes: 27,
  });
  assert.equal(JSON.stringify(result).includes('<strong>'), false);
  assert.equal(calls.some(([method]) => method === 'Browser.setPermission'), false);
});

test('clipboard write fails before CDP dispatch when the explicit payload exceeds bounds', async () => {
  let calls = 0;
  const session = { async send(): Promise<any> { calls += 1; return {}; } };
  const result = await new CdpClipboardController(session).write(
    'main',
    { text: '0123456789' },
    { maxTotalBytes: 8, maxBytesPerType: 8 },
  );
  assert.equal(result.status, 'payload-too-large');
  assert.equal(calls, 0);
});

test('clipboard read exposes only explicit bounded plain/html payload and exact byte counts', async () => {
  const session = {
    async send(method: string): Promise<any> {
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate') return { result: { objectId: 'global' } };
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: {
          status: 'read',
          text: 'A🙂BC',
          html: '<b>ABCDE</b>',
          types: ['text/plain', 'text/html'],
          truncated: false,
        } } };
      }
      if (method === 'Runtime.releaseObject') return {};
      throw new Error(`Unexpected ${method}`);
    },
  };

  const result = await new CdpClipboardController(session).read('main', {
    maxTotalBytes: 10,
    maxBytesPerType: 7,
  });
  assert.equal(result.status, 'read');
  assert.equal(result.payload?.text, 'A🙂BC');
  assert.equal(result.payload?.html, '<b>');
  assert.deepEqual(result.types, ['text/plain', 'text/html']);
  assert.equal(result.totalBytes, 10);
  assert.equal(result.truncated, true);
});

test('clipboard policy rejection is returned by name without retaining browser messages', async () => {
  const session = {
    async send(method: string): Promise<any> {
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 7 };
      if (method === 'Runtime.evaluate') return { result: { objectId: 'global' } };
      if (method === 'Runtime.callFunctionOn') {
        return { result: { value: { status: 'rejected', errorName: 'NotAllowedError' } } };
      }
      if (method === 'Runtime.releaseObject') return {};
      throw new Error(`Unexpected ${method}`);
    },
  };

  const result = await new CdpClipboardController(session).read('main');
  assert.deepEqual(result, {
    status: 'rejected', frameId: 'main', types: [], totalBytes: 0, truncated: false,
    errorName: 'NotAllowedError',
  });
});
