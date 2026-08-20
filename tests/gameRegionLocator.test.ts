import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpGameRegionLocator } from '../src/browser/gameRegionLocator.js';
import type { CdpSessionLike } from '../src/browser/cdpIdentity.js';

function box(x: number, y: number, width: number, height: number) {
  return {
    model: {
      border: [x, y, x + width, y, x + width, y + height, x, y + height],
    },
  };
}

test('game region locator favors a substantial canvas over a somewhat larger iframe', async () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const session: CdpSessionLike = {
    async send(method, params = {}) {
      calls.push([method, params]);
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      }
      if (method === 'DOM.enable' || method === 'DOM.getDocument' || method === 'DOM.discardSearchResults') {
        return {};
      }
      if (method === 'DOM.performSearch') return { searchId: 'search-1', resultCount: 4 };
      if (method === 'DOM.getSearchResults') return { nodeIds: [1, 2, 3, 4] };
      if (method === 'DOM.describeNode') {
        if (params.nodeId === 1) return { node: { backendNodeId: 101, localName: 'iframe' } };
        if (params.nodeId === 2) return { node: { backendNodeId: 102, localName: 'canvas' } };
        if (params.nodeId === 3) return { node: { backendNodeId: 103, localName: 'video' } };
        return { node: { backendNodeId: 104, localName: 'div', attributes: ['role', 'application'] } };
      }
      if (method === 'DOM.getBoxModel') {
        if (params.nodeId === 1) return box(0, 0, 600, 400);
        if (params.nodeId === 2) return box(0, 0, 500, 300);
        if (params.nodeId === 3) return box(0, 0, 80, 80);
        return box(900, 0, 400, 300);
      }
      throw new Error(`unexpected CDP method: ${method}`);
    },
  };

  const result = await new CdpGameRegionLocator(session).locate();

  assert.equal(result.primary?.kind, 'canvas');
  assert.deepEqual(result.candidates.map((candidate) => candidate.backendNodeId), [102, 101]);
  assert.deepEqual(result.primary?.clip, { x: 0, y: 0, width: 500, height: 300 });
  assert.equal(calls.at(-1)?.[0], 'DOM.discardSearchResults');
});

test('game region locator bounds DOM search and returned candidates', async () => {
  const session: CdpSessionLike = {
    async send(method, params = {}) {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 500, clientHeight: 500 } };
      }
      if (method === 'DOM.enable' || method === 'DOM.getDocument' || method === 'DOM.discardSearchResults') {
        return {};
      }
      if (method === 'DOM.performSearch') return { searchId: 'search-2', resultCount: 20 };
      if (method === 'DOM.getSearchResults') {
        assert.equal(params.toIndex, 2);
        return { nodeIds: [1, 2] };
      }
      if (method === 'DOM.describeNode') {
        const nodeId = Number(params.nodeId);
        return { node: { backendNodeId: 100 + nodeId, localName: 'canvas' } };
      }
      if (method === 'DOM.getBoxModel') return box(0, 0, 200, 200);
      throw new Error(`unexpected CDP method: ${method}`);
    },
  };

  const result = await new CdpGameRegionLocator(session).locate({
    maxSearchResults: 2,
    maxCandidates: 1,
  });

  assert.equal(result.candidates.length, 1);
});

test('game region locator validates bounded search options before browser work', async () => {
  const calls: string[] = [];
  const session: CdpSessionLike = {
    async send(method) {
      calls.push(method);
      return {};
    },
  };

  await assert.rejects(
    new CdpGameRegionLocator(session).locate({ minVisibleFraction: 2 }),
    /must be in \[0,1\]/,
  );
  assert.deepEqual(calls, []);
});
