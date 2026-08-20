import test from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotDocumentContent,
  type DocumentContentOptions,
} from '../src/browser/documentContent.js';
import type {
  SnapshotFrameLike,
  SnapshotPageLike,
} from '../src/browser/domSnapshot.js';

function frame(value: unknown | Error): SnapshotFrameLike {
  return {
    async evaluate() {
      if (value instanceof Error) throw value;
      return value as never;
    },
  };
}

function page(values: readonly (unknown | Error)[]): SnapshotPageLike {
  const frames = values.map(frame);
  return { frames: () => frames };
}

function raw(blocks: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    title: 'Example',
    language: 'en',
    description: 'Description',
    canonicalUrl: 'https://example.test/article',
    blocks,
    truncated: false,
    ...overrides,
  };
}

function block(
  path: string,
  text: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    path,
    kind: 'paragraph',
    tagName: 'p',
    depth: 3,
    text,
    rect: { x: 10, y: 20, width: 100, height: 30 },
    rendered: true,
    inViewport: true,
    truncated: false,
    ...overrides,
  };
}

test('document snapshot preserves frame order, metadata, and structural identities', async () => {
  const snapshot = await snapshotDocumentContent(page([
    raw([
      block('body:nth-of-type(1) > h1:nth-of-type(1)', 'Heading', {
        kind: 'heading', tagName: 'h1', level: 1,
      }),
      block('body:nth-of-type(1) > p:nth-of-type(1)', 'Main paragraph'),
    ]),
    raw([
      block('body:nth-of-type(1) > p:nth-of-type(1)', 'Frame paragraph'),
    ], { title: 'Frame' }),
  ]));

  assert.deepEqual(snapshot.frames.map((item) => [item.frameId, item.title, item.includedBlocks]), [
    ['main', 'Example', 2],
    ['frame-1', 'Frame', 1],
  ]);
  assert.deepEqual(snapshot.blocks.map((item) => [item.frameId, item.kind, item.text]), [
    ['main', 'heading', 'Heading'],
    ['main', 'paragraph', 'Main paragraph'],
    ['frame-1', 'paragraph', 'Frame paragraph'],
  ]);
  assert.match(snapshot.blocks[0].id, /^main:/);
  assert.match(snapshot.blocks[2].id, /^frame-1:/);
  assert.equal(snapshot.truncated, false);
  assert.deepEqual(snapshot.frameErrors, []);
});

test('document snapshot distinguishes hidden, offscreen, and viewport-only content', async () => {
  const source = page([raw([
    block('visible', 'visible'),
    block('offscreen', 'offscreen', { inViewport: false }),
    block('hidden', 'hidden', { rendered: false, inViewport: false }),
  ])]);

  const normal = await snapshotDocumentContent(source);
  assert.deepEqual(normal.blocks.map((item) => item.text), ['visible', 'offscreen']);

  const viewport = await snapshotDocumentContent(source, { viewportOnly: true });
  assert.deepEqual(viewport.blocks.map((item) => item.text), ['visible']);

  const hidden = await snapshotDocumentContent(source, { includeHidden: true });
  assert.deepEqual(hidden.blocks.map((item) => item.text), ['visible', 'offscreen', 'hidden']);
});

test('document snapshot applies exact combined UTF-8 and per-field bounds', async () => {
  const options: DocumentContentOptions = {
    maxBlocks: 10,
    maxTextBytes: 7,
    maxTextBytesPerBlock: 5,
  };
  const snapshot = await snapshotDocumentContent(page([raw([
    block('one', 'ééé'),
    block('two', 'abc'),
  ])]), options);

  // Each é is two UTF-8 bytes. The first field is capped at four bytes without
  // splitting a code point, leaving three bytes for the second block.
  assert.equal(snapshot.blocks[0].text, 'éé');
  assert.equal(snapshot.blocks[0].truncated, true);
  assert.equal(snapshot.blocks[1].text, 'abc');
  assert.equal(snapshot.totalTextBytes, 7);
  assert.equal(snapshot.truncated, true);
});

test('document snapshot enforces block/depth limits and surfaces frame extraction failures', async () => {
  const snapshot = await snapshotDocumentContent(page([
    raw([
      block('too-deep', 'deep', { depth: 10 }),
      block('one', 'one', { depth: 1 }),
      block('two', 'two', { depth: 1 }),
    ]),
    new Error('frame detached'),
  ]), {
    maxBlocks: 1,
    maxDepth: 2,
  });

  assert.deepEqual(snapshot.blocks.map((item) => item.text), ['one']);
  assert.equal(snapshot.truncated, true);
  // The global block budget stops before attempting later frames.
  assert.deepEqual(snapshot.frameErrors, []);
});

test('document snapshot records frame errors when budget permits later frames', async () => {
  const snapshot = await snapshotDocumentContent(page([
    raw([block('one', 'one')]),
    new Error('frame detached'),
  ]), { maxBlocks: 10 });

  assert.deepEqual(snapshot.frameErrors, [
    { frameId: 'frame-1', message: 'frame detached' },
  ]);
  assert.equal(snapshot.blocks.length, 1);
});
