import test from 'node:test';
import assert from 'node:assert/strict';
import {
  snapshotDocumentSelection,
} from '../src/browser/documentSelection.js';
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

function domSelection(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'dom',
    collapsed: false,
    direction: 'forward',
    selectedText: 'beta',
    selectedTextTruncated: false,
    anchor: { path: 'body > div::text(0)', offset: 6, nodeType: 'text' },
    focus: { path: 'body > div::text(0)', offset: 10, nodeType: 'text' },
    editingHost: { path: 'body > div', tagName: 'div', contentEditable: 'true' },
    rangeCount: 1,
    boundingRect: { x: 10, y: 20, width: 40, height: 18 },
    rects: [
      { x: 10, y: 20, width: 10, height: 18 },
      { x: 20, y: 20, width: 10, height: 18 },
      { x: 30, y: 20, width: 10, height: 18 },
    ],
    rectsTruncated: false,
    ...overrides,
  };
}

test('selection snapshot adds frame identity and applies host-side text/rectangle bounds', async () => {
  const snapshot = await snapshotDocumentSelection(page([
    domSelection({ selectedText: 'ééé', rectsTruncated: false }),
  ]), {
    maxSelectedTextBytes: 5,
    maxRects: 2,
  });

  assert.equal(snapshot.selections.length, 1);
  const selection = snapshot.selections[0];
  assert.equal(selection.frameId, 'main');
  assert.equal(selection.selectedText, 'éé');
  assert.equal(selection.selectedTextTruncated, true);
  assert.equal(selection.rects.length, 2);
  assert.equal(selection.rectsTruncated, true);
  assert.equal(snapshot.truncated, true);
});

test('collapsed non-editable DOM carets are hidden by default but can be requested', async () => {
  const source = page([domSelection({
    collapsed: true,
    direction: 'none',
    selectedText: undefined,
    editingHost: undefined,
  })]);

  const hidden = await snapshotDocumentSelection(source);
  assert.deepEqual(hidden.selections, []);

  const included = await snapshotDocumentSelection(source, {
    includeCollapsedNonEditable: true,
  });
  assert.equal(included.selections.length, 1);
  assert.equal(included.selections[0].collapsed, true);
});

test('backward text-control selection preserves anchor/focus direction', async () => {
  const snapshot = await snapshotDocumentSelection(page([{
    kind: 'text-control',
    collapsed: false,
    direction: 'backward',
    selectedText: 'bcd',
    selectedTextTruncated: false,
    anchor: { path: 'body > input', offset: 4, nodeType: 'element' },
    focus: { path: 'body > input', offset: 1, nodeType: 'element' },
    editingHost: { path: 'body > input', tagName: 'input' },
    start: 1,
    end: 4,
    rangeCount: 1,
    rects: [],
    rectsTruncated: false,
  }]));

  const selection = snapshot.selections[0];
  assert.equal(selection.kind, 'text-control');
  assert.equal(selection.direction, 'backward');
  assert.equal(selection.anchor?.offset, 4);
  assert.equal(selection.focus?.offset, 1);
  assert.equal(selection.start, 1);
  assert.equal(selection.end, 4);
});

test('selection snapshot records one frame failure without discarding another frame', async () => {
  const snapshot = await snapshotDocumentSelection(page([
    domSelection(),
    new Error('detached frame'),
  ]));

  assert.equal(snapshot.selections.length, 1);
  assert.deepEqual(snapshot.frameErrors, [
    { frameId: 'frame-1', message: 'detached frame' },
  ]);
});
