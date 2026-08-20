import test from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentContentBlock, DocumentContentSnapshot } from '../src/browser/documentContent.js';
import { diffDocumentContent } from '../src/browser/documentDiff.js';

function block(
  id: string,
  text: string,
  overrides: Partial<DocumentContentBlock> = {},
): DocumentContentBlock {
  return {
    id,
    frameId: 'main',
    kind: 'paragraph',
    tagName: 'p',
    depth: 3,
    text,
    rect: { x: 20, y: 100, width: 700, height: 40 },
    rendered: true,
    inViewport: true,
    truncated: false,
    ...overrides,
  };
}

function snapshot(blocks: DocumentContentBlock[], overrides: Partial<DocumentContentSnapshot> = {}): DocumentContentSnapshot {
  return {
    frames: [{ frameId: 'main', title: 'Synthetic', includedBlocks: blocks.length, browserExtractionTruncated: false }],
    blocks,
    totalTextBytes: 0,
    truncated: false,
    frameErrors: [],
    ...overrides,
  };
}

test('diffs exact identities, semantic changes, relocations, and likely content updates deterministically', () => {
  const stableHeading = block('main:body:nth-of-type(1) > main:nth-of-type(1) > h1:nth-of-type(1)', 'Research notes', { kind: 'heading', tagName: 'h1', level: 1 });
  const changedId = 'main:body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(1)';
  const removedId = 'main:body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(2)';
  const relocatedBefore = 'main:body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(3)';
  const relocatedAfter = 'main:body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(4)';
  const addedId = 'main:body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(5)';

  const previous = snapshot([
    stableHeading,
    block(changedId, 'The original article paragraph contains substantive sentence-like content for comparison.'),
    block(removedId, 'This substantive paragraph is removed in the next snapshot and should be reported.'),
    block(relocatedBefore, 'This exact stable paragraph moves structurally but does not change semantically.'),
  ]);
  const current = snapshot([
    structuredClone(stableHeading),
    block(changedId, 'The revised article paragraph contains substantive sentence-like content and a meaningful update.', { rect: { x: 20, y: 110, width: 700, height: 50 } }),
    block(relocatedAfter, 'This exact stable paragraph moves structurally but does not change semantically.'),
    block(addedId, 'A newly added substantive paragraph contributes additional article information for readers.'),
  ]);

  const first = diffDocumentContent(previous, current);
  const second = diffDocumentContent(previous, current);
  assert.deepEqual(first, second);
  assert.ok(first.addedBlockIds.includes(addedId));
  assert.ok(first.addedBlockIds.includes(relocatedAfter));
  assert.ok(first.removedBlockIds.includes(removedId));
  assert.ok(first.removedBlockIds.includes(relocatedBefore));
  assert.deepEqual(first.relocatedBlocks, [{ previousBlockId: relocatedBefore, currentBlockId: relocatedAfter }]);

  const changed = first.changedBlocks.find((item) => item.blockId === changedId);
  assert.equal(changed?.contentChanged, true);
  assert.equal(changed?.presentationChanged, true);
  assert.ok(changed?.changedFields.includes('text'));
  assert.ok(changed?.changedFields.includes('rect'));

  assert.ok(first.likelyContentUpdates.some((item) => item.kind === 'modified' && item.currentBlockId === changedId));
  assert.ok(first.likelyContentUpdates.some((item) => item.kind === 'added' && item.currentBlockId === addedId));
  assert.ok(first.likelyContentUpdates.some((item) => item.kind === 'removed' && item.previousBlockId === removedId));
  assert.ok(!first.likelyContentUpdates.some((item) => item.currentBlockId === relocatedAfter || item.previousBlockId === relocatedBefore));
  assert.ok(first.refreshHints.some((hint) => hint.reason === 'content-update' && hint.scope === 'region'));
  assert.equal(first.unchangedBlockCount, 1);
});

test('does not treat viewport-only movement as a semantic content update', () => {
  const id = 'main:body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(1)';
  const previous = snapshot([block(id, 'Stable article content remains identical across observations.')]);
  const current = snapshot([block(id, 'Stable article content remains identical across observations.', {
    inViewport: false,
    rect: { x: 20, y: 1200, width: 700, height: 40 },
  })]);

  const diff = diffDocumentContent(previous, current);
  assert.equal(diff.changedBlocks[0].contentChanged, false);
  assert.equal(diff.changedBlocks[0].presentationChanged, true);
  assert.deepEqual(diff.likelyContentUpdates, []);
  assert.deepEqual(diff.refreshHints, []);
});

test('surfaces frame-level refresh hints for extraction failures and truncation', () => {
  const source = snapshot([block('main:body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(1)', 'Stable text.')]);
  const current = snapshot([block('main:body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(1)', 'Stable text.', { truncated: true })], {
    truncated: true,
    frameErrors: [{ frameId: 'frame-1', message: 'frame detached' }],
  });
  const diff = diffDocumentContent(source, current);

  assert.ok(diff.refreshHints.some((hint) => hint.frameId === 'frame-1' && hint.reason === 'frame-error' && hint.scope === 'frame'));
  assert.ok(diff.refreshHints.some((hint) => hint.frameId === 'main' && hint.reason === 'truncated-extraction'));
  assert.equal(diff.truncated, true);
});

test('does not report removals when a previously readable frame becomes unreadable', () => {
  const frameId = 'frame-1';
  const oldId = `${frameId}:body:nth-of-type(1) > article:nth-of-type(1) > p:nth-of-type(1)`;
  const previous = snapshot([block(oldId, 'Previously readable article content.', { frameId })], {
    frames: [{ frameId, title: 'Child', includedBlocks: 1, browserExtractionTruncated: false }],
  });
  const current = snapshot([], {
    frames: [],
    frameErrors: [{ frameId, message: 'frame detached during extraction' }],
  });

  const diff = diffDocumentContent(previous, current);
  assert.deepEqual(diff.removedBlockIds, []);
  assert.deepEqual(diff.addedBlockIds, []);
  assert.deepEqual(diff.changedBlocks, []);
  assert.deepEqual(diff.relocatedBlocks, []);
  assert.deepEqual(diff.likelyContentUpdates, []);
  assert.deepEqual(diff.removedFrameIds, []);
  assert.equal(diff.truncated, true);
  assert.ok(diff.refreshHints.some((hint) => hint.frameId === frameId && hint.reason === 'frame-error'));
});

test('does not report additions when a previously unreadable frame becomes readable', () => {
  const frameId = 'frame-1';
  const newId = `${frameId}:body:nth-of-type(1) > article:nth-of-type(1) > p:nth-of-type(1)`;
  const previous = snapshot([], {
    frames: [],
    frameErrors: [{ frameId, message: 'frame unavailable' }],
  });
  const current = snapshot([block(newId, 'Now readable article content.', { frameId })], {
    frames: [{ frameId, title: 'Child', includedBlocks: 1, browserExtractionTruncated: false }],
  });

  const diff = diffDocumentContent(previous, current);
  assert.deepEqual(diff.addedBlockIds, []);
  assert.deepEqual(diff.removedBlockIds, []);
  assert.deepEqual(diff.changedBlocks, []);
  assert.deepEqual(diff.relocatedBlocks, []);
  assert.deepEqual(diff.likelyContentUpdates, []);
  assert.deepEqual(diff.addedFrameIds, []);
  assert.equal(diff.truncated, true);
  assert.ok(diff.refreshHints.some((hint) => hint.frameId === frameId && hint.reason === 'frame-error'));
});

test('orders equal-priority refresh hints by locale-independent code units', () => {
  const previous = snapshot([], { frames: [] });
  const current = snapshot([], {
    frames: [],
    frameErrors: [
      { frameId: 'a-frame', message: 'unreadable' },
      { frameId: 'Z-frame', message: 'unreadable' },
    ],
  });

  const diff = diffDocumentContent(previous, current);
  assert.deepEqual(diff.refreshHints.map((hint) => hint.frameId), ['Z-frame', 'a-frame']);
});

test('bounds exact change output and marks the derived diff truncated', () => {
  const previous = snapshot([]);
  const current = snapshot([
    block('main:body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(1)', 'First new article paragraph with useful information.'),
    block('main:body:nth-of-type(1) > main:nth-of-type(1) > p:nth-of-type(2)', 'Second new article paragraph with useful information.'),
  ]);
  const diff = diffDocumentContent(previous, current, { maxAddedBlocks: 1 });
  assert.equal(diff.addedBlockIds.length, 1);
  assert.equal(diff.truncated, true);
});
