import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpInputAdapter } from '../src/input/cdpInputAdapter.js';
import type { CdpSessionLike } from '../src/browser/cdpIdentity.js';

test('CDP exact text insertion uses Input.insertText without synthesizing key events', async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const session: CdpSessionLike = {
    async send(method, params) {
      calls.push({ method, params });
      return {};
    },
  };

  await new CdpInputAdapter(session).insertText('δ🙂');
  assert.deepEqual(calls, [
    { method: 'Input.insertText', params: { text: 'δ🙂' } },
  ]);
});
