import test from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentSelectionSnapshot } from '../src/browser/documentSelection.js';
import { DocumentSelectionObserver } from '../src/browser/documentSelection.js';
import { RichTextController } from '../src/controller/richTextController.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { Point } from '../src/types.js';

function snapshot(
  collapsed: boolean,
  overrides: Record<string, unknown> = {},
): DocumentSelectionSnapshot {
  return {
    selections: [{
      frameId: 'main',
      kind: 'dom',
      collapsed,
      direction: collapsed ? 'none' : 'forward',
      ...(collapsed ? {} : { selectedText: 'beta' }),
      selectedTextTruncated: false,
      editingHost: { path: 'body > div', tagName: 'div', contentEditable: 'true' },
      rangeCount: 1,
      rects: [],
      rectsTruncated: false,
      ...overrides,
    }],
    frameErrors: [],
    truncated: false,
  };
}

class Input implements BrowserInput {
  readonly events: string[] = [];
  async movePointer(_point: Point) {}
  async pointerDown(_button: MouseButton = 'left') {}
  async pointerUp(_button: MouseButton = 'left') {}
  async pressKey(key: string) { this.events.push(`press:${key}`); }
  async keyDown(_key: string) {}
  async keyUp(_key: string) {}
  async typeText(_text: string) {}
  async insertText(text: string) { this.events.push(`insert:${text}`); }
  async scroll(_delta: Point) {}
}

function observer(states: readonly DocumentSelectionSnapshot[]): DocumentSelectionObserver {
  let index = 0;
  return {
    async snapshot() {
      return states[Math.min(index++, states.length - 1)];
    },
  } as unknown as DocumentSelectionObserver;
}

test('rich text insertion dispatches exact insertion and verifies selection collapse', async () => {
  const input = new Input();
  const controller = new RichTextController(input, observer([
    snapshot(false),
    snapshot(true),
  ]));

  const result = await controller.insertText('δ🙂');
  assert.equal(result.status, 'inserted');
  assert.equal(result.selectionCollapsed, true);
  assert.deepEqual(input.events, ['insert:δ🙂']);
});

test('rich text insertion enforces payload bounds before dispatch', async () => {
  const input = new Input();
  const controller = new RichTextController(input, observer([snapshot(false)]));
  const result = await controller.insertText('éé', { maxTextBytes: 3 });
  assert.equal(result.status, 'text-too-large');
  assert.deepEqual(input.events, []);
});

test('rich text editing fails closed for no editable or ambiguous selection', async () => {
  const input = new Input();
  const none = new RichTextController(input, observer([{
    selections: [], frameErrors: [], truncated: false,
  }]));
  assert.equal((await none.insertText('x')).status, 'no-editable-selection');

  const ambiguousSnapshot = snapshot(false);
  ambiguousSnapshot.selections.push({
    ...ambiguousSnapshot.selections[0],
    frameId: 'frame-1',
  });
  const ambiguous = new RichTextController(input, observer([ambiguousSnapshot]));
  assert.equal((await ambiguous.insertText('x')).status, 'selection-ambiguous');
  assert.deepEqual(input.events, []);
});

test('select-all and delete use native keyboard commands and verify resulting selection state', async () => {
  const input = new Input();
  const controller = new RichTextController(input, observer([
    snapshot(true),
    snapshot(false, { selectedText: 'alpha beta gamma' }),
    snapshot(false, { selectedText: 'alpha beta gamma' }),
    snapshot(true),
  ]));

  const selected = await controller.selectAll({ primaryModifier: 'Control' });
  assert.equal(selected.status, 'selected-all');
  const deleted = await controller.deleteSelection();
  assert.equal(deleted.status, 'deleted');
  assert.deepEqual(input.events, ['press:Control+a', 'press:Backspace']);
});

test('select-all rejects invalid runtime modifier names before browser input', async () => {
  const input = new Input();
  const controller = new RichTextController(input, observer([snapshot(true)]));
  await assert.rejects(
    () => controller.selectAll({ primaryModifier: 'AltGraph' as 'Control' }),
    /Control or Meta/,
  );
  assert.deepEqual(input.events, []);
});