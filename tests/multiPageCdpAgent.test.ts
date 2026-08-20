import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CdpTargetSessionRouter,
  type CdpMultiplexEventListener,
} from '../src/browser/cdpSessionRouter.js';
import { MultiPageCdpAgent } from '../src/engine/multiPageCdpAgent.js';
import type { CdpBrowserAgentEngine } from '../src/engine/cdpBrowserAgentEngine.js';

class Connection {
  readonly calls: Array<[string, Record<string, unknown>, string | undefined]> = [];
  readonly listeners = new Map<string, Set<CdpMultiplexEventListener>>();
  targets = [
    { targetId: 'page-1', type: 'page', attached: false, url: 'https://secret.example/', title: 'Secret' },
    { targetId: 'worker-1', type: 'worker', attached: false, url: 'https://secret.example/worker.js', title: '' },
  ];

  async send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    this.calls.push([method, params, sessionId]);
    if (method === 'Target.getTargets') return { targetInfos: this.targets };
    if (method === 'Target.setDiscoverTargets') return {};
    if (method === 'Target.attachToTarget') return { sessionId: `session-${params.targetId}` };
    if (method === 'Target.activateTarget' || method === 'Target.detachFromTarget') return {};
    if (method === 'Target.createTarget') {
      const targetId = 'page-2';
      this.targets.push({ targetId, type: 'page', attached: false, url: params.url, title: 'Created' });
      return { targetId };
    }
    if (method === 'Target.closeTarget') return { success: true };
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
}

function fakeEngine(id: string): CdpBrowserAgentEngine {
  return {
    async prepare() {},
    marker: id,
  } as unknown as CdpBrowserAgentEngine;
}

test('multi-page agent lazily attaches, activates, reuses, and redacts target metadata', async () => {
  const connection = new Connection();
  const router = new CdpTargetSessionRouter(connection);
  let engines = 0;
  const agent = new MultiPageCdpAgent(
    router,
    {},
    undefined,
    async (session) => {
      engines += 1;
      return fakeEngine(session.targetId);
    },
  );

  const first = await agent.switchTo('page-1');
  assert.deepEqual(first, { status: 'switched', targetId: 'page-1', reused: false });
  assert.equal(engines, 1);
  assert.equal(agent.summary().activeTargetId, 'page-1');

  const again = await agent.switchTo('page-1');
  assert.equal(again.status, 'switched');
  assert.equal(again.reused, true);
  assert.equal(engines, 1);
  assert.equal(
    connection.calls.filter(([method]) => method === 'Target.attachToTarget').length,
    1,
  );

  const worker = await agent.switchTo('worker-1');
  assert.equal(worker.status, 'not-page');
  const serialized = JSON.stringify(agent.summary());
  assert.equal(serialized.includes('secret.example'), false);
  assert.equal(serialized.includes('Secret'), false);
});

test('multi-page create-and-switch enforces target navigation policy before creation', async () => {
  const connection = new Connection();
  const router = new CdpTargetSessionRouter(connection);
  const agent = new MultiPageCdpAgent(
    router,
    { navigationPolicy: { allowedOrigins: ['https://allowed.example'] } },
    undefined,
    async (session) => fakeEngine(session.targetId),
  );

  const blocked = await agent.createAndSwitch('https://blocked.example/path');
  assert.equal(blocked.status, 'policy-blocked');
  assert.equal(
    connection.calls.some(([method]) => method === 'Target.createTarget'),
    false,
  );

  const allowed = await agent.createAndSwitch('https://allowed.example/path');
  assert.equal(allowed.status, 'switched');
  assert.equal(allowed.targetId, 'page-2');
});

test('multi-page close detaches its semantic session before explicit target close', async () => {
  const connection = new Connection();
  const router = new CdpTargetSessionRouter(connection);
  const agent = new MultiPageCdpAgent(
    router,
    {},
    undefined,
    async (session) => fakeEngine(session.targetId),
  );
  await agent.switchTo('page-1');

  const closed = await agent.closePage('page-1');
  assert.equal(closed.status, 'closed');
  const methods = connection.calls.map(([method]) => method);
  assert.ok(methods.indexOf('Target.detachFromTarget') < methods.indexOf('Target.closeTarget'));
  assert.equal(agent.summary().activeTargetId, undefined);
  assert.equal(agent.summary().attachedPages, 0);
});
