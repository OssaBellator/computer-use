import { Buffer } from 'node:buffer';
import {
  type DocumentFormattingOptions,
  DocumentFormattingObserver,
  type DocumentFormattingSnapshot,
  type DocumentFormattingState,
} from '../browser/documentFormatting.js';
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

export type RichTextNativeInlineFormat = 'bold' | 'italic' | 'underline';

export type RichTextFormatStatus =
  | 'formatted'
  | 'unchanged'
  | 'no-editable-selection'
  | 'selection-ambiguous'
  | 'unsupported-editor'
  | 'formatting-unavailable'
  | 'formatting-ambiguous'
  | 'formatting-mixed'
  | 'formatting-unobservable'
  | 'unverified';

export interface RichTextFormatOptions {
  /** Defaults to Meta on Darwin and Control elsewhere. */
  primaryModifier?: 'Control' | 'Meta';
  selection?: DocumentSelectionOptions;
  formatting?: DocumentFormattingOptions;
}

export interface RichTextFormatResult {
  status: RichTextFormatStatus;
  format: RichTextNativeInlineFormat;
  enabled: boolean;
  before?: DocumentFormattingSnapshot;
  after?: DocumentFormattingSnapshot;
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

function matchingFormatting(
  selection: DocumentSelectionState,
  snapshot: DocumentFormattingSnapshot,
): DocumentFormattingState | undefined {
  if (snapshot.states.length !== 1) return undefined;
  const state = snapshot.states[0];
  return state.frameId === selection.frameId &&
    state.editingHost.path === selection.editingHost?.path
    ? state
    : undefined;
}

function isNativeInlineFormat(value: unknown): value is RichTextNativeInlineFormat {
  return value === 'bold' || value === 'italic' || value === 'underline';
}

function resolvePrimaryModifier(value: unknown): 'Control' | 'Meta' {
  if (value === undefined) return process.platform === 'darwin' ? 'Meta' : 'Control';
  if (value !== 'Control' && value !== 'Meta') {
    throw new Error('primaryModifier must be Control or Meta');
  }
  return value;
}

function sameFormattingSelection(
  before: DocumentSelectionState,
  after: DocumentSelectionState,
): boolean {
  if (before.collapsed !== after.collapsed) return false;
  if (
    !before.collapsed &&
    !before.selectedTextTruncated &&
    !after.selectedTextTruncated &&
    (before.selectedText ?? '') !== (after.selectedText ?? '')
  ) {
    return false;
  }
  return true;
}

function resultWithoutDispatch(
  status: RichTextEditStatus,
  snapshot: DocumentSelectionSnapshot,
): RichTextEditResult {
  return { status, before: snapshot, after: snapshot };
}

function formatResult(
  status: RichTextFormatStatus,
  format: RichTextNativeInlineFormat,
  enabled: boolean,
  before?: DocumentFormattingSnapshot,
  after?: DocumentFormattingSnapshot,
): RichTextFormatResult {
  return {
    status,
    format,
    enabled,
    ...(before ? { before } : {}),
    ...(after ? { after } : {}),
  };
}

/**
 * Native-selection editing primitives layered on BrowserInput and the bounded
 * selection observer. No editor DOM is mutated directly.
 */
export class RichTextController {
  constructor(
    private readonly input: BrowserInput,
    readonly selections: DocumentSelectionObserver,
    readonly formatting?: DocumentFormattingObserver,
  ) {}

  observe(options: DocumentSelectionOptions = {}): Promise<DocumentSelectionSnapshot> {
    return this.selections.snapshot(options);
  }

  observeFormatting(
    options: DocumentFormattingOptions = {},
  ): Promise<DocumentFormattingSnapshot | undefined> {
    return this.formatting?.snapshot(options) ?? Promise.resolve(undefined);
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
    const primaryModifier = resolvePrimaryModifier(options.primaryModifier);
    const before = await this.observe(options.selection);
    const candidate = uniqueEditableSelection(before);
    if (candidate.status === 'none') return resultWithoutDispatch('no-editable-selection', before);
    if (candidate.status === 'ambiguous') return resultWithoutDispatch('selection-ambiguous', before);

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

  setBold(
    enabled: boolean,
    options: RichTextFormatOptions = {},
  ): Promise<RichTextFormatResult> {
    return this.setInlineFormat('bold', enabled, options);
  }

  setItalic(
    enabled: boolean,
    options: RichTextFormatOptions = {},
  ): Promise<RichTextFormatResult> {
    return this.setInlineFormat('italic', enabled, options);
  }

  setUnderline(
    enabled: boolean,
    options: RichTextFormatOptions = {},
  ): Promise<RichTextFormatResult> {
    return this.setInlineFormat('underline', enabled, options);
  }

  async setInlineFormat(
    format: RichTextNativeInlineFormat,
    enabled: boolean,
    options: RichTextFormatOptions = {},
  ): Promise<RichTextFormatResult> {
    if (!isNativeInlineFormat(format)) {
      throw new Error('format must be bold, italic, or underline');
    }
    if (typeof enabled !== 'boolean') {
      throw new Error('enabled must be a boolean');
    }
    const primaryModifier = resolvePrimaryModifier(options.primaryModifier);

    const selectionBefore = await this.observe(options.selection);
    const candidate = uniqueEditableSelection(selectionBefore);
    if (selectionBefore.frameErrors.length > 0) {
      return formatResult('selection-ambiguous', format, enabled);
    }
    if (candidate.status === 'none') {
      return formatResult('no-editable-selection', format, enabled);
    }
    if (candidate.status === 'ambiguous') {
      return formatResult('selection-ambiguous', format, enabled);
    }
    if (candidate.selection.kind !== 'dom') {
      return formatResult('unsupported-editor', format, enabled);
    }
    if (candidate.selection.rangeCount !== 1) {
      return formatResult('selection-ambiguous', format, enabled);
    }
    if (!this.formatting) {
      return formatResult('formatting-unavailable', format, enabled);
    }

    const before = await this.formatting.snapshot(options.formatting);
    if (before.frameErrors.length > 0 || before.states.length > 1) {
      return formatResult('formatting-ambiguous', format, enabled, before, before);
    }
    const current = matchingFormatting(candidate.selection, before);
    if (!current || !current.complete) {
      return formatResult('formatting-unobservable', format, enabled, before, before);
    }
    const value = current.summary[format];
    if (value === 'unknown') {
      return formatResult('formatting-unobservable', format, enabled, before, before);
    }
    if (value === 'mixed') {
      return formatResult('formatting-mixed', format, enabled, before, before);
    }
    const desired = enabled ? 'on' : 'off';
    if (value === desired) {
      return formatResult('unchanged', format, enabled, before, before);
    }

    const key = format === 'bold' ? 'b' : format === 'italic' ? 'i' : 'u';
    await this.input.pressKey(`${primaryModifier}+${key}`);

    const selectionAfter = await this.observe(options.selection);
    if (selectionAfter.frameErrors.length > 0) {
      const after = await this.formatting.snapshot(options.formatting);
      return formatResult('unverified', format, enabled, before, after);
    }
    const afterSelection = matchingAfter(candidate.selection, selectionAfter);
    if (
      !afterSelection ||
      afterSelection.kind !== 'dom' ||
      afterSelection.rangeCount !== 1 ||
      !sameFormattingSelection(candidate.selection, afterSelection)
    ) {
      const after = await this.formatting.snapshot(options.formatting);
      return formatResult('unverified', format, enabled, before, after);
    }

    const after = await this.formatting.snapshot(options.formatting);
    const verified = matchingFormatting(afterSelection, after);
    if (after.frameErrors.length > 0 || !verified || !verified.complete || verified.summary[format] !== desired) {
      return formatResult('unverified', format, enabled, before, after);
    }
    return formatResult('formatted', format, enabled, before, after);
  }
}