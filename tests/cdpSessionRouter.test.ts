import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CdpTargetSessionRouter,
  type CdpMultiplexEventListener,
} from '../src/browser/cdpSessionRouter.js';

class Connection {
  readonly calls: Array<[string, Record<string, unknown>, string | undefined]> = [];
  readonly listeners = new Map<string, Set<CdpMultiplexEventListener>>();
  attachCount = 0;

  async send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<any> {
    this.calls.push([method, params, sessionId]);
    if (method === 'Target.attachToTarget') {
      this.attachCount += 1;
      return { sessionId: `session-${this.attachCount}` };
    }
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

test('repeated attach reuses the one routed debugger session for a target', async () => {
  const connection = new Connection();
  const router = new CdpTargetSessionRouter(connection);
  const first = await router.attach('target-1');
  const second = await router.attach('target-1');

  assert.equal(second, first);
  assert.equal(connection.attachCount, 1);
  assert.equal(router.sessionFor('target-1'), first);
});

test('externally-created flattened session can be adopted and reused by attach', async () => {
  const connection = new Connection();
  const router = new CdpTargetSessionRouter(connection);
  const adopted = router.adopt('target-guarded', 'security-session');
  const attached = await router.attach('target-guarded');

  assert.equal(attached, adopted);
  assert.equal(attached.sessionId, 'security-session');
  assert.equal(connection.attachCount, 0);
  assert.throws(
    () => router.adopt('target-guarded', 'different-session'),
    /different routed CDP session/,
  );
});

test('detach cleans routed listeners, forgets registry entry, and permits a later fresh attach', async () => {
  const connection = new Connection();
  const router = new CdpTargetSessionRouter(connection);
  const session = await router.attach('target-1');
  session.on('Page.loadEventFired', () => {});

  await router.detach(session);
  assert.equal(session.detached, true);
  assert.equal(router.sessionFor('target-1'), undefined);
  assert.equal(connection.listeners.get('Page.loadEventFired')?.size ?? 0, 0);
  await assert.rejects(() => session.send('Runtime.evaluate', { expression: '1' }), /detached/);
  assert.equal(
    connection.calls.some(([method, params]) =>
      method === 'Target.detachFromTarget' && params.sessionId === 'session-1'),
    true,
  );

  const replacement = await router.attach('target-1');
  assert.notEqual(replacement, session);
  assert.equal(replacement.sessionId, 'session-2');
});
