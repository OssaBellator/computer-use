// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { SetCellFormulaIntent, SetCellValueIntent } from '../src/computer/documentModels.js';
import { DeterministicSpreadsheetBackend, SpreadsheetSemanticController, type SpreadsheetDispatchResult } from '../src/application/spreadsheetSemanticAdapter.js';

const singleBounds = { maxItems: 1, maxTextBytes: 256 };
const rangeBounds = { maxItems: 16, maxTextBytes: 1024 };
function valueEdit(backend: DeterministicSpreadsheetBackend, value: string | number | boolean | null = 'updated'): SetCellValueIntent {
  return { kind: 'set-cell-value', intentId: 'cell-value-1', document: backend.currentDocument(), effect: 'local-reversible-edit', target: backend.cellRange(0, 0), value };
}
function rangeValueEdit(backend: DeterministicSpreadsheetBackend, value: string | number | boolean | null, endRow: number, endColumn: number): SetCellValueIntent {
  const intent = valueEdit(backend, value); intent.target.end = { row: endRow, column: endColumn }; return intent;
}

test('document replacement rejects stale edit before dispatch', async () => {
  class ReplacingBackend extends DeterministicSpreadsheetBackend { private once = true; override async readRevision(): Promise<number> { const r = await super.readRevision(); if (this.once) { this.once = false; this.replaceDocument(); } return r; } }
  const backend = new ReplacingBackend('sheet-doc-replace'); const result = await new SpreadsheetSemanticController(backend).execute(valueEdit(backend), singleBounds);
  assert.equal(result.status, 'rejected'); assert.equal(result.dispatch, 'not-dispatched'); assert.equal(backend.dispatchCount, 0);
});

test('stale sheet generation is rejected immediately before dispatch', async () => {
  class ReplacingSheetBackend extends DeterministicSpreadsheetBackend { private once = true; override async readRevision(): Promise<number> { const r = await super.readRevision(); if (this.once) { this.once = false; this.replaceSheet(); } return r; } }
  const backend = new ReplacingSheetBackend('sheet-entity'); const result = await new SpreadsheetSemanticController(backend).execute(valueEdit(backend), singleBounds);
  assert.equal(result.status, 'rejected'); assert.equal(backend.dispatchCount, 0);
});

test('cell observation is bounded by items and text bytes', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-bounds'); backend.seedCell({ row: 0, column: 0 }, { kind: 'value', value: 'alpha' }); backend.seedCell({ row: 0, column: 1 }, { kind: 'value', value: 'beta' });
  const range = { sheet: backend.sheetRef(), start: { row: 0, column: 0 }, end: { row: 0, column: 1 } };
  const byItems = await backend.observeCells(range, { maxItems: 1, maxTextBytes: 64 }); if (byItems.kind === 'cells') { assert.equal(byItems.cells.length, 1); assert.equal(byItems.truncated, true); }
  const byBytes = await backend.observeCells(range, { maxItems: 2, maxTextBytes: 5 }); if (byBytes.kind === 'cells') assert.equal(byBytes.truncated, true);
});

test('native value update dispatches once and verifies model input', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-value'); const before = await backend.readRevision();
  const result = await new SpreadsheetSemanticController(backend).execute(valueEdit(backend, 42), singleBounds);
  assert.equal(result.status, 'verified'); assert.equal(backend.dispatchCount, 1); assert.equal(await backend.readRevision(), before + 1);
});

test('native formula update verifies formula input', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-formula');
  const intent: SetCellFormulaIntent = { kind: 'set-cell-formula', intentId: 'formula', document: backend.currentDocument(), effect: 'local-reversible-edit', target: backend.cellRange(2, 3), formula: 'SUM(A1:A3)' };
  assert.equal((await new SpreadsheetSemanticController(backend).execute(intent, singleBounds)).status, 'verified');
});

test('atomic 2x2 value update uses one dispatch and one revision while verifying every cell', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-range-value'); const before = await backend.readRevision();
  const result = await new SpreadsheetSemanticController(backend).execute(rangeValueEdit(backend, 'R', 1, 1), rangeBounds);
  assert.equal(result.status, 'verified'); assert.equal(result.dispatch, 'dispatched'); assert.equal(backend.dispatchCount, 1); assert.equal(await backend.readRevision(), before + 1);
  if (result.status === 'verified') assert.deepEqual(result.verification.evidence, ['cell-range-model-matches']);
  const observed = await backend.observeCells({ sheet: backend.sheetRef(), start: { row: 0, column: 0 }, end: { row: 1, column: 1 } }, rangeBounds);
  assert.equal(observed.kind, 'cells'); if (observed.kind === 'cells') { assert.equal(observed.cells.length, 4); for (const cell of observed.cells) assert.deepEqual(cell.input, { kind: 'value', value: 'R' }); }
});

test('atomic formula row update verifies every formula input', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-range-formula');
  const intent: SetCellFormulaIntent = { kind: 'set-cell-formula', intentId: 'range-formula', document: backend.currentDocument(), effect: 'local-reversible-edit', target: { sheet: backend.sheetRef(), start: { row: 2, column: 0 }, end: { row: 2, column: 2 } }, formula: 'A1+1' };
  const result = await new SpreadsheetSemanticController(backend).execute(intent, rangeBounds);
  assert.equal(result.status, 'verified'); assert.equal(backend.dispatchCount, 1);
  const observed = await backend.observeCells(intent.target, rangeBounds); if (observed.kind === 'cells') for (const cell of observed.cells) assert.deepEqual(cell.input, { kind: 'formula', formula: 'A1+1' });
});

test('verification capacity too small rejects range before dispatch', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-range-capacity');
  const result = await new SpreadsheetSemanticController(backend).execute(rangeValueEdit(backend, 'wide', 1, 1), { maxItems: 3, maxTextBytes: 1024 });
  assert.equal(result.status, 'rejected'); assert.equal(result.dispatch, 'not-dispatched'); assert.equal(backend.dispatchCount, 0); if (result.status === 'rejected') assert.match(result.reason, /verification bounds/);
});

test('verification byte budget too small rejects before dispatch', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-range-bytes');
  const result = await new SpreadsheetSemanticController(backend).execute(rangeValueEdit(backend, 'long', 0, 2), { maxItems: 3, maxTextBytes: 11 });
  assert.equal(result.status, 'rejected'); assert.equal(backend.dispatchCount, 0);
});

test('caller intent is snapshotted before awaits', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-snapshot'); const intent = valueEdit(backend, 'original'); const promise = new SpreadsheetSemanticController(backend).execute(intent, singleBounds); intent.value = 'mutated'; intent.target.sheet.generation = 99; assert.equal((await promise).status, 'verified');
});

test('backend-truncated range observation cannot prove success even when requested bounds were sufficient', async () => {
  class TruncatingBackend extends DeterministicSpreadsheetBackend {
    override async observeCells(target: Parameters<DeterministicSpreadsheetBackend['observeCells']>[0], bounds: Parameters<DeterministicSpreadsheetBackend['observeCells']>[1]): ReturnType<DeterministicSpreadsheetBackend['observeCells']> {
      return super.observeCells(target, { ...bounds, maxItems: 1 });
    }
  }
  const backend = new TruncatingBackend('sheet-malicious-truncation'); const result = await new SpreadsheetSemanticController(backend).execute(rangeValueEdit(backend, 'X', 1, 1), rangeBounds);
  assert.equal(result.status, 'verification-failed'); assert.equal(result.dispatch, 'dispatched'); assert.equal(backend.dispatchCount, 1); if (result.status === 'verification-failed') assert.equal(result.verification.status, 'insufficient-observation');
});

test('backend result mutation cannot substitute for model verification', async () => {
  class MutatingBackend extends DeterministicSpreadsheetBackend { override async dispatchSemanticEdit(intent: Parameters<DeterministicSpreadsheetBackend['dispatchSemanticEdit']>[0]): Promise<SpreadsheetDispatchResult> { const r = await super.dispatchSemanticEdit(intent); r.revision = -1; return r; } }
  const backend = new MutatingBackend('sheet-result'); assert.equal((await new SpreadsheetSemanticController(backend).execute(valueEdit(backend), singleBounds)).status, 'verified');
});

test('backend that mutates then throws is uncertain and not replayed', async () => {
  class MutateThenThrowBackend extends DeterministicSpreadsheetBackend { override async dispatchSemanticEdit(intent: Parameters<DeterministicSpreadsheetBackend['dispatchSemanticEdit']>[0]): Promise<SpreadsheetDispatchResult> { await super.dispatchSemanticEdit(intent); throw new Error('lost after dispatch'); } }
  const backend = new MutateThenThrowBackend('sheet-throw'); const result = await new SpreadsheetSemanticController(backend).execute(rangeValueEdit(backend, 'once', 0, 1), rangeBounds);
  assert.equal(result.status, 'uncertain'); assert.equal(result.dispatch, 'uncertain'); assert.equal(backend.dispatchCount, 1); if (result.status === 'uncertain') assert.equal(result.verification.status, 'verified');
});

test('explicit uncertain range dispatch is never automatically replayed', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-uncertain'); backend.markNextDispatchUncertain(); const result = await new SpreadsheetSemanticController(backend).execute(rangeValueEdit(backend, 'U', 0, 1), rangeBounds); assert.equal(result.status, 'uncertain'); assert.equal(backend.dispatchCount, 1);
});
