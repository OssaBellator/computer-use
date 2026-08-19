import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpBrowserAgentEngine } from '../src/engine/cdpBrowserAgentEngine.js';
import type {
  BrowserHistoryController,
  BrowserHistoryOptions,
  BrowserHistoryResult,
} from '../src/browser/historyController.js';
import type { BrowserNavigator } from '../src/browser/navigationController.js';
import type { InteractionEngine } from '../src/engine/interactionEngine.js';

const interaction = {
  async refresh() { return []; },
  async activate() { return { status: 'verified', target: null }; },
  async typeInto() { return { status: 'verified', target: null }; },
} as unknown as InteractionEngine;

const session = {
  async send(method: string) {
    if (method !== 'Runtime.evaluate') throw new Error(`unexpected method: ${method}`);
    return {
      result: {
        value: {
          url: 'about:blank',
          origin: 'null',
          title: '',
          readyState: 'complete',
          historyLength: 1,
          timeOrigin: 1000,
        },
      },
    };
  },
};

const navigator: BrowserNavigator = {
  async navigate(url) {
    return { status: 'navigated', requestedUrl: url, polls: 1 };
  },
};

test('browser-agent facade delegates bounded history and reload actions', async () => {
  const calls: Array<[string, BrowserHistoryOptions | undefined]> = [];
  const result = (action: 'back' | 'forward' | 'reload'): BrowserHistoryResult => ({
    status: 'navigated', action, polls: 1,
  });
  const history: BrowserHistoryController = {
    async back(options) { calls.push(['back', options]); return result('back'); },
    async forward(options) { calls.push(['forward', options]); return result('forward'); },
    async reload(options) { calls.push(['reload', options]); return result('reload'); },
  };
  const engine = new CdpBrowserAgentEngine(
    interaction,
    session,
    navigator,
    undefined,
    undefined,
    undefined,
    history,
  );

  assert.equal((await engine.goBack({ waitUntil: 'interactive' })).status, 'navigated');
  assert.equal((await engine.goForward()).action, 'forward');
  assert.equal((await engine.reload({ ignoreCache: true })).action, 'reload');
  assert.deepEqual(calls, [
    ['back', { waitUntil: 'interactive' }],
    ['forward', undefined],
    ['reload', { ignoreCache: true }],
  ]);
});
