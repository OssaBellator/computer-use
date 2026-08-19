import test from 'node:test';
import assert from 'node:assert/strict';
import { MultiPageTaskEngine } from '../src/engine/multiPageTaskEngine.js';
import type { MultiPageCdpAgent } from '../src/engine/multiPageCdpAgent.js';
import type { InteractionNode } from '../src/types.js';

const summary = {
  total: 2,
  pages: 2,
  unattachedPages: 1,
  latestPage: { targetId: 'page-2', type: 'page', attached: false, sequence: 2 },
  latestUnattachedPage: { targetId: 'page-2', type: 'page', attached: false, sequence: 2 },
};

function activeNode(): InteractionNode {
  return {
    id: 'active', frameId: 'main', role: 'button', name: 'Active', focused: false,
    disabled: false, focusable: true, clickable: true, editable: false, scrollable: false,
    capabilities: ['focus', 'activate'], interactionConfidence: 1,
  };
}

test('multi-page task adapter exposes root target topology before a page is active', async () => {
  let started = 0;
  const pages = {
    activeEngine: undefined,
    async start() { started += 1; },
    targets: {
      summary: () => summary,
      async createPage(url: string) { return { status: 'created', requestedUrl: url, targetId: 'page-3' }; },
      async closeLatestUnattachedPage() { return { status: 'closed', targetId: 'page-2' }; },
    },
    async switchToLatestPage() { return { status: 'switched', targetId: 'page-2', reused: false }; },
    async switchToLatestUnattachedPage() { return { status: 'switched', targetId: 'page-2', reused: false }; },
  } as unknown as MultiPageCdpAgent;
  const engine = new MultiPageTaskEngine(pages);

  await engine.prepare();
  assert.equal(started, 1);
  assert.deepEqual(await engine.refresh(), []);
  assert.equal(engine.browserState(), undefined);
  assert.equal(engine.targetState().pages, 2);
  assert.equal((await engine.switchPage('latest-page')).status, 'switched');
  assert.equal((await engine.switchPage('latest-unattached-page')).targetId, 'page-2');
});

test('multi-page task adapter delegates semantic actions to the active page engine', async () => {
  const node = activeNode();
  const activeEngine = {
    async refresh() { return [node]; },
    async activate() { return { status: 'verified', target: node }; },
    async typeInto() { return { status: 'verified', target: node }; },
    async browserState() {
      return {
        url: 'about:blank', origin: 'null', title: '', readyState: 'complete',
        historyLength: 1, timeOrigin: 1,
      };
    },
  };
  const pages = {
    activeEngine,
    async start() {},
    targets: { summary: () => summary },
  } as unknown as MultiPageCdpAgent;
  const engine = new MultiPageTaskEngine(pages);

  assert.equal((await engine.refresh())[0]?.id, 'active');
  assert.equal((await engine.activate('active')).status, 'verified');
  assert.equal((await engine.typeInto('active', 'x')).status, 'verified');
  assert.equal((await engine.browserState())?.url, 'about:blank');
});
