import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpNetworkActivityMonitor } from '../src/browser/networkActivityMonitor.js';
import type { CdpEventSessionLike } from '../src/browser/dialogController.js';

class Session implements CdpEventSessionLike {
  readonly listeners = new Map<string, Set<(params: any) => void>>();
  readonly calls: Array<[string, Record<string, unknown> | undefined]> = [];
  async send(method: string, params?: Record<string, unknown>): Promise<any> { this.calls.push([method, params]); return {}; }
  on(event: string, listener: (params: any) => void): void { let set = this.listeners.get(event); if (!set) { set = new Set(); this.listeners.set(event, set); } set.add(listener); }
  off(event: string, listener: (params: any) => void): void { this.listeners.get(event)?.delete(listener); }
  emit(event: string, params: any): void { for (const listener of this.listeners.get(event) ?? []) listener(params); }
}

test('network monitor retains lifecycle counts without URL metadata', async () => {
  const session = new Session();
  const monitor = new CdpNetworkActivityMonitor(session);
  await monitor.start();
  const secretUrl = 'https://secret.example/account?token=hidden';
  session.emit('Network.requestWillBeSent', { requestId: 'r1', request: { url: secretUrl } });
  session.emit('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 12 });
  assert.deepEqual(monitor.summary(), { inFlight: 0, started: 1, finished: 1, failed: 0, activitySequence: 2 });
  assert.equal(JSON.stringify(monitor.summary()).includes(secretUrl), false);
  assert.equal(session.calls[0]?.[0], 'Network.enable');
});

test('redirect-style duplicate request id does not inflate unique in-flight starts', async () => {
  const session = new Session();
  const monitor = new CdpNetworkActivityMonitor(session);
  session.emit('Network.requestWillBeSent', { requestId: 'r1' });
  session.emit('Network.requestWillBeSent', { requestId: 'r1', redirectResponse: {} });
  assert.equal(monitor.summary().inFlight, 1);
  assert.equal(monitor.summary().started, 1);
  assert.equal(monitor.summary().activitySequence, 2);
});

test('network idle requires a continuous quiet period after activity', async () => {
  const session = new Session();
  const monitor = new CdpNetworkActivityMonitor(session);
  let now = 0;
  let sleeps = 0;
  session.emit('Network.requestWillBeSent', { requestId: 'r1' });
  const resultPromise = monitor.waitForIdle({
    quietMs: 20,
    timeoutMs: 100,
    pollIntervalMs: 10,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
      sleeps += 1;
      if (sleeps === 1) session.emit('Network.loadingFinished', { requestId: 'r1' });
    },
  });
  const result = await resultPromise;
  assert.equal(result.idle, true);
  assert.equal(result.summary.inFlight, 0);
  assert.ok(result.elapsedMs >= 20);
});

test('network idle fails closed on timeout when requests remain in flight', async () => {
  const session = new Session();
  const monitor = new CdpNetworkActivityMonitor(session);
  session.emit('Network.requestWillBeSent', { requestId: 'r1' });
  let now = 0;
  const result = await monitor.waitForIdle({
    quietMs: 5,
    timeoutMs: 20,
    pollIntervalMs: 10,
    now: () => now,
    sleep: async (ms) => { now += ms; },
  });
  assert.equal(result.idle, false);
  assert.equal(result.summary.inFlight, 1);
});

test('dispose removes listeners and clears transient request ids', () => {
  const session = new Session();
  const monitor = new CdpNetworkActivityMonitor(session);
  session.emit('Network.requestWillBeSent', { requestId: 'r1' });
  monitor.dispose();
  assert.equal(monitor.summary().inFlight, 0);
  session.emit('Network.requestWillBeSent', { requestId: 'r2' });
  assert.equal(monitor.summary().inFlight, 0);
});
