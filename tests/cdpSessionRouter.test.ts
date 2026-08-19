import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CdpTargetSessionRouter,
  type CdpMultiplexEventListener,
} from '../src/browser/cdpSessionRouter.js';

class Connection {
  readonly calls: Array<[string, Record<string, unknown>, string | undefined]> = [];
  readonly listeners = new Map<string, Set<CdpMultiplexEventListener>>();

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<any> {
    this.calls.push([method, params, sessionId]);
    if (method === 'Target.attachToTarget') return { sessionId: 'session-1' };
    if (method === 'Runtime.evaluate') return { result: { value: 2 } };
    return {};
  }

  on(event: string, listener: CdpMultiplexEventListener): void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  off(event: string, listener: CdpMultiplexEventListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, params: any, sessionId?: string): void {
    for (const listener of this.listeners.get(event) ?? []) listener(params, sessionId);
  }
}

test('routed session sends flattened commands and filters events by session id', async () => {
  const connection = new Connection();
  const router = new CdpTargetSessionRouter(connection);
  const session = await router.attach('target-1');

  const result = await session.send('Runtime.evaluate', { expression: '1+1' });
  assert.equal(result.result.value, 2);
  assert.deepEqual(connection.calls[1], [
    'Runtime.evaluate', { expression: '1+1' }, 'session-1',
  ]);

  let events = 0;
  const listener = () => { events += 1; };
  session.on('Runtime.consoleAPICalled', listener);
  connection.emit('Runtime.consoleAPICalled', {}, 'other-session');
  connection.emit('Runtime.consoleAPICalled', {}, 'session-1');
  assert.equal(events, 1);
  session.off?.('Runtime.consoleAPICalled', listener);
  connection.emit('Runtime.consoleAPICalled', {}, 'session-1');
  assert.equal(events, 1);
});

test('root session receives only browser-root events', () => {
  const connection = new Connection();
  const router = new CdpTargetSessionRouter(connection);
  let events = 0;
  router.root.on('Target.targetCreated', () => { events += 1; });

  connection.emit('Target.targetCreated', { targetInfo: {} });
  connection.emit('Target.targetCreated', { targetInfo: {} }, 'session-1');
  assert.equal(events, 1);
});

test('detach cleans routed listeners and rejects future commands', async () => {
  const connection = new Connection();
  const router = new CdpTargetSessionRouter(connection);
  const session = await router.attach('target-1');
  session.on('Page.loadEventFired', () => {});

  await router.detach(session);
  assert.equal(session.detached, true);
  assert.equal(connection.listeners.get('Page.loadEventFired')?.size ?? 0, 0);
  await assert.rejects(() => session.send('Runtime.evaluate', { expression: '1' }), /detached/);
  assert.equal(
    connection.calls.some(([method, params]) =>
      method === 'Target.detachFromTarget' && params.sessionId === 'session-1'),
    true,
  );
});
