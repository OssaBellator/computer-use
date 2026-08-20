import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpDownloadController } from '../src/browser/downloadController.js';
import { createCdpBrowserAgentEngine } from '../src/engine/cdpBrowserAgentEngine.js';

test('CDP browser-agent factory enables downloads only when explicit filesystem options are provided', () => {
  const page = { frames: () => [] };
  const session = {
    on() {},
    off() {},
    async send() { return {}; },
  };
  const disabled = createCdpBrowserAgentEngine(page, session, { coalesceSnapshots: false });
  assert.equal(disabled.downloads, undefined);

  const enabled = createCdpBrowserAgentEngine(page, session, {
    coalesceSnapshots: false,
    downloadOptions: { downloadPath: '/tmp/browser-agent-download-test' },
  });
  assert.ok(enabled.downloads instanceof CdpDownloadController);
});
