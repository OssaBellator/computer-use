import test from 'node:test';
import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { snapshotDocumentFormatting } from '../src/browser/documentFormatting.js';
import type { SnapshotFrameLike, SnapshotPageLike } from '../src/browser/domSnapshot.js';

function frame(value: unknown | Error): SnapshotFrameLike {
  return { async evaluate() { if (value instanceof Error) throw value; return value as never; } };
}
function page(values: readonly (unknown | Error)[]): SnapshotPageLike { return { frames: () => values.map(frame) }; }
function raw(overrides: Record<string, unknown> = {}) {
  const block = { kind: 'paragraph' as const };
  return {
    collapsed: false,
    editingHost: { path: 'body:nth-of-type(1) > div:nth-of-type(1)', tagName: 'div', contentEditable: 'true' },
    summary: { bold: 'mixed', italic: 'off', underline: 'off', strike: 'off', code: 'off', link: 'mixed' },
    linkTarget: { state: 'mixed' as const },
    runs: [
      { bold: true, italic: false, underline: false, strike: false, code: false, link: { url: 'https://x/éé', urlTruncated: false }, block, textNodes: 1 },
      { bold: false, italic: false, underline: false, strike: false, code: false, block: { kind: 'heading', headingLevel: 2 }, textNodes: 1 },
    ],
    runsTruncated: false,
    blocks: [block, { kind: 'heading', headingLevel: 2 }],
    blocksTruncated: false,
    complete: true,
    ...overrides,
  };
}

test('formatting snapshot preserves explicit mixed state while bounding runs, blocks, and UTF-8 URLs', async () => {
  const snapshot = await snapshotDocumentFormatting(page([raw()]), { maxRuns: 1, maxBlocks: 1, maxLinkUrlBytes: 12 });
  assert.equal(snapshot.states.length, 1);
  const state = snapshot.states[0];
  assert.equal(state.frameId, 'main');
  assert.equal(state.summary.bold, 'mixed');
  assert.equal(state.runs.length, 1);
  assert.equal(state.runsTruncated, true);
  assert.equal(state.blocks.length, 1);
  assert.equal(state.blocksTruncated, true);
  assert.equal(state.runs[0].link?.url, 'https://x/é');
  assert.ok(Buffer.byteLength(state.runs[0].link?.url ?? '', 'utf8') <= 12);
  assert.equal(state.runs[0].link?.urlTruncated, true);
  assert.equal(snapshot.truncated, true);
});

test('uniform link-target summaries keep URL identity while applying the URL byte budget', async () => {
  const snapshot = await snapshotDocumentFormatting(page([raw({
    linkTarget: { state: 'uniform', link: { url: 'https://x/éé', urlTruncated: false } },
  })]), { maxLinkUrlBytes: 12 });
  const target = snapshot.states[0].linkTarget;
  assert.equal(target.state, 'uniform');
  assert.equal(target.link?.url, 'https://x/é');
  assert.equal(target.link?.urlTruncated, true);
  assert.ok(Buffer.byteLength(target.link?.url ?? '', 'utf8') <= 12);
  assert.equal(snapshot.truncated, true);
});

test('formatting observation is frame-scoped and records fail-closed frame errors', async () => {
  const snapshot = await snapshotDocumentFormatting(page([raw(), { error: 'selection-crosses-editing-hosts' }]));
  assert.equal(snapshot.states[0].frameId, 'main');
  assert.deepEqual(snapshot.frameErrors, [{ frameId: 'frame-1', message: 'selection-crosses-editing-hosts' }]);
});

test('formatting observation validates host-side budgets', async () => {
  await assert.rejects(() => snapshotDocumentFormatting(page([raw()]), { maxRuns: 0 }), /positive integer/);
  await assert.rejects(() => snapshotDocumentFormatting(page([raw()]), { maxLinkUrlBytes: 1.5 }), /positive integer/);
});

test('incomplete uniform observation is explicitly unknown while certain mixed state remains mixed', async () => {
  const snapshot = await snapshotDocumentFormatting(page([raw({
    complete: false,
    summary: {
      bold: 'unknown', italic: 'unknown', underline: 'unknown', strike: 'unknown', code: 'unknown', link: 'mixed',
    },
    linkTarget: { state: 'mixed' },
  })]));
  assert.equal(snapshot.states[0].complete, false);
  assert.equal(snapshot.states[0].summary.bold, 'unknown');
  assert.equal(snapshot.states[0].summary.link, 'mixed');
  assert.equal(snapshot.states[0].linkTarget.state, 'mixed');
});