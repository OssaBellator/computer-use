import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpNavigationGuard } from '../src/browser/navigationGuard.js';
import type { CdpEventSessionLike } from '../src/browser/dialogController.js';

class Session implements CdpEventSessionLike {
  readonly listeners = new Map<string, Set<(params: any) => void>>();
  readonly calls: Array<[string, Record<string, unknown>]> = [];

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    this.calls.push([method, params]);
    return {};
  }

  on(event: string, listener: (params: any) => void): void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  off(event: string, listener: (params: any) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, params: any): void {
    for (const listener of this.listeners.get(event) ?? []) listener(params);
  }
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('navigation guard enables Document request interception and continues allowlisted navigation', async () => {
  const session = new Session();
  const guard = new CdpNavigationGuard(session, {
    allowedOrigins: ['https://allowed.example'],
  });
  await guard.start();
  session.emit('Fetch.requestPaused', {
    requestId: 'request-1',
    resourceType: 'Document',
    request: { url: 'https://allowed.example/path' },
  });
  await settle();

  assert.deepEqual(session.calls[0], [
    'Fetch.enable',
    { patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }] },
  ]);
  assert.equal(
    session.calls.some(([method, params]) =>
      method === 'Fetch.continueRequest' && params.requestId === 'request-1'),
    true,
  );
  assert.deepEqual(guard.summary(), { paused: 1, continued: 1, blocked: 0 });
});

test('navigation guard blocks non-allowlisted document before request dispatch without retaining its URL', async () => {
  const session = new Session();
  const guard = new CdpNavigationGuard(session, {
    allowedOrigins: ['https://allowed.example'],
  });
  await guard.start();
  const blockedUrl = 'https://blocked.example/secret';
  session.emit('Fetch.requestPaused', {
    requestId: 'request-2',
    resourceType: 'Document',
    request: { url: blockedUrl },
  });
  await settle();

  assert.equal(
    session.calls.some(([method, params]) =>
      method === 'Fetch.failRequest' &&
      params.requestId === 'request-2' &&
      params.errorReason === 'BlockedByClient'),
    true,
  );
  assert.deepEqual(guard.summary(), {
    paused: 1, continued: 0, blocked: 1, latestBlockedSequence: 1,
  });
  assert.equal(JSON.stringify(guard.summary()).includes(blockedUrl), false);
});

test('navigation guard fails closed for malformed document URLs and continues unexpected non-document pauses', async () => {
  const session = new Session();
  const guard = new CdpNavigationGuard(session);
  await guard.start();

  session.emit('Fetch.requestPaused', {
    requestId: 'request-3', resourceType: 'Document', request: { url: 'not absolute' },
  });
  session.emit('Fetch.requestPaused', {
    requestId: 'request-4', resourceType: 'Script', request: { url: 'https://example.test/a.js' },
  });
  await settle();

  assert.equal(
    session.calls.some(([method, params]) =>
      method === 'Fetch.failRequest' && params.requestId === 'request-3'),
    true,
  );
  assert.equal(
    session.calls.some(([method, params]) =>
      method === 'Fetch.continueRequest' && params.requestId === 'request-4'),
    true,
  );
  assert.deepEqual(guard.summary(), {
    paused: 2, continued: 1, blocked: 1, latestBlockedSequence: 1,
  });
});

test('navigation guard listener can be disposed without exposing blocked destinations', async () => {
  const session = new Session();
  const guard = new CdpNavigationGuard(session);
  await guard.start();
  guard.dispose();
  session.emit('Fetch.requestPaused', {
    requestId: 'request-5', resourceType: 'Document', request: { url: 'https://example.test/' },
  });
  await settle();
  assert.deepEqual(guard.summary(), { paused: 0, continued: 0, blocked: 0 });
});
