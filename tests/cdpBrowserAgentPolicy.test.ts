import test from 'node:test';
import assert from 'node:assert/strict';
import { createCdpBrowserAgentEngine } from '../src/engine/cdpBrowserAgentEngine.js';

test('CDP browser-agent factory applies navigation policy without leaking it into interaction options', async () => {
  const page = { frames: () => [] };
  const session = {
    async send(method: string) {
      if (method === 'Runtime.evaluate') return { result: { value: {
        url: 'about:blank', origin: 'null', title: '', readyState: 'complete', historyLength: 1, timeOrigin: 1,
      } } };
      return {};
    },
  };
  const engine = createCdpBrowserAgentEngine(page, session, {
    navigationPolicy: { allowedOrigins: ['https://example.test'] },
    coalesceSnapshots: false,
  });
  const blocked = await engine.navigate('https://evil.test/');
  assert.equal(blocked.status, 'policy-blocked');
  assert.match(blocked.policyReason ?? '', /not allowlisted/);
});
