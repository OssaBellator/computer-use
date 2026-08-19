import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpBrowserAgentEngine } from '../src/engine/cdpBrowserAgentEngine.js';
import { InteractionEngine } from '../src/engine/interactionEngine.js';
import {
  createPureCdpBrowserAgentEngine,
  createPureCdpInteractionEngine,
} from '../src/engine/pureCdpEngine.js';

const session = {
  async send(method: string) {
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'main', url: 'about:blank', name: '' } } };
    }
    throw new Error(`unexpected method: ${method}`);
  },
};

test('pure CDP factories construct interaction and browser-agent engines without a page object', async () => {
  const interaction = await createPureCdpInteractionEngine(session);
  assert.ok(interaction instanceof InteractionEngine);

  const agent = await createPureCdpBrowserAgentEngine(session);
  assert.ok(agent instanceof CdpBrowserAgentEngine);
  assert.ok(agent.interaction instanceof InteractionEngine);
});
