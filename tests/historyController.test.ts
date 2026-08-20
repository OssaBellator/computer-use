import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpHistoryController } from '../src/browser/historyController.js';
import type { BrowserStateSnapshot } from '../src/browser/browserState.js';
import type { CdpSessionLike } from '../src/browser/cdpIdentity.js';

function state(url: string, timeOrigin: number): BrowserStateSnapshot {
  return {
    url,
    origin: url.startsWith('http') ? new URL(url).origin : 'null',
    title: '',
    readyState: 'complete',
    historyLength: 3,
    timeOrigin,
  };
}

class Session implements CdpSessionLike {
  readonly calls: Array<[string, Record<string, unknown>]> = [];
  current = 1;
  states = [
    state('about:blank#one', 1),
    state('about:blank#two', 2),
    state('about:blank#three', 3),
  ];

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    this.calls.push([method, params]);
    if (method === 'Runtime.evaluate') return { result: { value: this.states[this.current] } };
    if (method === 'Page.getNavigationHistory') {
      return {
        currentIndex: this.current,
        entries: this.states.map((item, index) => ({ id: index + 10, url: item.url })),
      };
    }
    if (method === 'Page.navigateToHistoryEntry') {
      this.current = this.states.findIndex((_item, index) => index + 10 === params.entryId);
      return {};
    }
    if (method === 'Page.reload') {
      this.states[this.current] = {
        ...this.states[this.current]!,
        timeOrigin: this.states[this.current]!.timeOrigin + 100,
      };
      return {};
    }
    throw new Error(`unexpected CDP method: ${method}`);
  }
}

test('history controller verifies back and forward traversal', async () => {
  const session = new Session();
  const controller = new CdpHistoryController(session);

  const back = await controller.back({ pollIntervalMs: 0 });
  assert.equal(back.status, 'navigated');
  assert.equal(back.after?.url, 'about:blank#one');

  const forward = await controller.forward({ pollIntervalMs: 0 });
  assert.equal(forward.status, 'navigated');
  assert.equal(forward.after?.url, 'about:blank#two');
});

test('history controller verifies reload by document identity', async () => {
  const session = new Session();
  const result = await new CdpHistoryController(session).reload({
    pollIntervalMs: 0,
    ignoreCache: true,
  });

  assert.equal(result.status, 'navigated');
  assert.notEqual(result.before?.timeOrigin, result.after?.timeOrigin);
  assert.deepEqual(
    session.calls.find(([method]) => method === 'Page.reload')?.[1],
    { ignoreCache: true },
  );
});

test('history destination is policy checked before browser dispatch', async () => {
  const session = new Session();
  session.states[0] = state('https://blocked.example/', 1);
  const result = await new CdpHistoryController(session, {
    allowedOrigins: ['https://allowed.example'],
  }).back();

  assert.equal(result.status, 'policy-blocked');
  assert.equal(
    session.calls.some(([method]) => method === 'Page.navigateToHistoryEntry'),
    false,
  );
});

test('history boundary fails closed without issuing a traversal command', async () => {
  const session = new Session();
  session.current = 0;
  const result = await new CdpHistoryController(session).back();

  assert.equal(result.status, 'no-history');
  assert.equal(
    session.calls.some(([method]) => method === 'Page.navigateToHistoryEntry'),
    false,
  );
});
