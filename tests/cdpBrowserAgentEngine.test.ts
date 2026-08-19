import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpBrowserAgentEngine } from '../src/engine/cdpBrowserAgentEngine.js';
import type { BrowserNavigator } from '../src/browser/navigationController.js';
import type { InteractionEngine } from '../src/engine/interactionEngine.js';

const interaction = {
  async refresh() { return []; },
  async activate() { return { status: 'verified', target: null }; },
  async typeInto() { return { status: 'verified', target: null }; },
} as unknown as InteractionEngine;

test('CDP browser-agent facade delegates semantic actions, browser state, and navigation', async () => {
  const session = {
    async send(method: string) {
      assert.equal(method, 'Runtime.evaluate');
      return {
        result: {
          value: {
            url: 'https://example.test/',
            origin: 'https://example.test',
            title: 'Example',
            readyState: 'complete',
            historyLength: 1,
            timeOrigin: 1000,
          },
        },
      };
    },
  };
  const navigations: string[] = [];
  const navigator: BrowserNavigator = {
    async navigate(url) {
      navigations.push(url);
      return { status: 'navigated', requestedUrl: url, polls: 1 };
    },
  };
  const engine = new CdpBrowserAgentEngine(interaction, session, navigator);

  assert.deepEqual(await engine.refresh(), []);
  assert.equal((await engine.activate('x')).status, 'verified');
  assert.equal((await engine.typeInto('x', 'value')).status, 'verified');
  assert.equal((await engine.browserState()).title, 'Example');
  assert.equal((await engine.navigate('https://example.test/next')).status, 'navigated');
  assert.deepEqual(navigations, ['https://example.test/next']);
});
