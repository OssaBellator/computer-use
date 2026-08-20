import { Buffer } from 'node:buffer';
import {
  DocumentSelectionObserver,
  type DocumentSelectionOptions,
  type DocumentSelectionSnapshot,
  type DocumentSelectionState,
} from '../browser/documentSelection.js';
import type { BrowserInput } from '../input/browserInput.js';

export type RichTextEditStatus =
  | 'inserted'
  | 'deleted'
  | 'selected-all'
  | 'no-editable-selection'
  | 'selection-ambiguous'
  | 'unsupported-input'
  | 'text-too-large'
  | 'unverified';

export interface RichTextEditResult {
  status: RichTextEditStatus;
  before: DocumentSelectionSnapshot;
  after: DocumentSelectionSnapshot;
  selectionCollapsed?: boolean;
}

export interface RichTextInsertOptions {
  /** Hard caller-side UTF-8 payload cap. Defaults to 65,536 bytes. */
  maxTextBytes?: number;
  selection?: DocumentSelectionOptions;
}

export interface RichTextSelectAllOptions {
  /** Defaults to Meta on Darwin and Control elsewhere. */
  primaryModifier?: 'Control' | 'Meta';
  selection?: DocumentSelectionOptions;
}

function editableSelections(snapshot: DocumentSelectionSnapshot): DocumentSelectionState[] {
  return snapshot.selections.filter((selection) => selection.editingHost !== undefined);
}

function uniqueEditableSelection(
  snapshot: DocumentSelectionSnapshot,
): { status: 'ok'; selection: DocumentSelectionState } |
   { status: 'none' } |
   { status: 'ambiguous' } {
  const candidates = editableSelections(snapshot);
  if (candidates.length === 0) return { status: 'none' };
  if (candidates.length > 1) return { status: 'ambiguous' };
  return { status: 'ok', selection: candidates[0] };
}

function matchingAfter(
  before: DocumentSelectionState,
  snapshot: DocumentSelectionSnapshot,
): DocumentSelectionState | undefined {
  return editableSelections(snapshot).find((selection) =>
    selection.frameId === before.frameId &&
    selection.editingHost?.path === before.editingHost?.path
  );
}

function resultWithoutDispatch(
  status: RichTextEditStatus,
  snapshot: DocumentSelectionSnapshot,
): RichTextEditResult {
  return { status, before: snapshot, after: snapshot };
}

/**
 * Native-selection editing primitives layered on BrowserInput and the bounded
 * selection observer. No editor DOM is mutated directly.
 */
export class RichTextController {
  constructor(
    private readonly input: BrowserInput,
    readonly selections: DocumentSelectionObserver,
  ) {}

  observe(options: DocumentSelectionOptions = {}): Promise<DocumentSelectionSnapshot> {
    return this.selections.snapshot(options);
  }

  async insertText(
    text: string,
    options: RichTextInsertOptions = {},
  ): Promise<RichTextEditResult> {
    const before = await this.observe(options.selection);
    const candidate = uniqueEditableSelection(before);
    if (candidate.status === 'none') return resultWithoutDispatch('no-editable-selection', before);
    if (candidate.status === 'ambiguous') return resultWithoutDispatch('selection-ambiguous', before);
    if (!this.input.insertText) return resultWithoutDispatch('unsupported-input', before);

    const maxTextBytes = options.maxTextBytes ?? 64 * 1024;
    if (!Number.isInteger(maxTextBytes) || maxTextBytes < 1) {
      throw new Error('maxTextBytes must be a positive integer');
    }
    if (Buffer.byteLength(text, 'utf8') > maxTextBytes) {
      return resultWithoutDispatch('text-too-large', before);
    }

    await this.input.insertText(text);
    const after = await this.observe(options.selection);
    const current = matchingAfter(candidate.selection, after);
    const selectionCollapsed = current?.collapsed === true;
    return {
      status: selectionCollapsed ? 'inserted' : 'unverified',
      before,
      after,
      selectionCollapsed,
    };
  }

  async deleteSelection(
    options: { selection?: DocumentSelectionOptions } = {},
  ): Promise<RichTextEditResult> {
    const before = await this.observe(options.selection);
    const candidate = uniqueEditableSelection(before);
    if (candidate.status === 'none') return resultWithoutDispatch('no-editable-selection', before);
    if (candidate.status === 'ambiguous') return resultWithoutDispatch('selection-ambiguous', before);
    if (candidate.selection.collapsed) return resultWithoutDispatch('unverified', before);

    await this.input.pressKey('Backspace');
    const after = await this.observe(options.selection);
    const current = matchingAfter(candidate.selection, after);
    const selectionCollapsed = current?.collapsed === true;
    return {
      status: selectionCollapsed ? 'deleted' : 'unverified',
      before,
      after,
      selectionCollapsed,
    };
  }

  async selectAll(
    options: RichTextSelectAllOptions = {},
  ): Promise<RichTextEditResult> {
    const before = await this.observe(options.selection);
    const candidate = uniqueEditableSelection(before);
    if (candidate.status === 'none') return resultWithoutDispatch('no-editable-selection', before);
    if (candidate.status === 'ambiguous') return resultWithoutDispatch('selection-ambiguous', before);

    const primaryModifier = options.primaryModifier ??
      (process.platform === 'darwin' ? 'Meta' : 'Control');
    await this.input.pressKey(`${primaryModifier}+a`);
    const after = await this.observe(options.selection);
    const current = matchingAfter(candidate.selection, after);
    const selected = current !== undefined && !current.collapsed;
    return {
      status: selected ? 'selected-all' : 'unverified',
      before,
      after,
      selectionCollapsed: current?.collapsed,
    };
  }
}
