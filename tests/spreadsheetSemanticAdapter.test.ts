// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { SetCellFormulaIntent, SetCellValueIntent } from '../src/computer/documentModels.js';
import { DeterministicSpreadsheetBackend, SpreadsheetSemanticController, type SpreadsheetDispatchResult } from '../src/application/spreadsheetSemanticAdapter.js';

const verificationBounds = { maxItems: 1, maxTextBytes: 256 };
function valueEdit(backend: DeterministicSpreadsheetBackend, value: string | number | boolean | null = 'updated'): SetCellValueIntent {
  return { kind: 'set-cell-value', intentId: 'cell-value-1', document: backend.currentDocument(), effect: 'local-reversible-edit', target: backend.cellRange(0, 0), value };
}

test('document replacement rejects stale edit before dispatch', async () => {
  class ReplacingBackend extends DeterministicSpreadsheetBackend { private once = true; override async readRevision(): Promise<number> { const r = await super.readRevision(); if (this.once) { this.once = false; this.replaceDocument(); } return r; } }
  const backend = new ReplacingBackend('sheet-doc-replace'); const result = await new SpreadsheetSemanticController(backend).execute(valueEdit(backend), verificationBounds);
  assert.equal(result.status, 'rejected'); assert.equal(result.dispatch, 'not-dispatched'); assert.equal(backend.dispatchCount, 0);
});

test('stale sheet generation is rejected immediately before dispatch', async () => {
  class ReplacingSheetBackend extends DeterministicSpreadsheetBackend { private once = true; override async readRevision(): Promise<number> { const r = await super.readRevision(); if (this.once) { this.once = false; this.replaceSheet(); } return r; } }
  const backend = new ReplacingSheetBackend('sheet-entity'); const result = await new SpreadsheetSemanticController(backend).execute(valueEdit(backend), verificationBounds);
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
  const result = await new SpreadsheetSemanticController(backend).execute(valueEdit(backend, 42), verificationBounds);
  assert.equal(result.status, 'verified'); assert.equal(backend.dispatchCount, 1); assert.equal(await backend.readRevision(), before + 1);
});

test('native formula update verifies formula input', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-formula');
  const intent: SetCellFormulaIntent = { kind: 'set-cell-formula', intentId: 'formula', document: backend.currentDocument(), effect: 'local-reversible-edit', target: backend.cellRange(2, 3), formula: 'SUM(A1:A3)' };
  const result = await new SpreadsheetSemanticController(backend).execute(intent, verificationBounds); assert.equal(result.status, 'verified');
});

test('caller intent is snapshotted before awaits', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-snapshot'); const intent = valueEdit(backend, 'original'); const promise = new SpreadsheetSemanticController(backend).execute(intent, verificationBounds); intent.value = 'mutated'; intent.target.sheet.generation = 99; assert.equal((await promise).status, 'verified');
});

test('truncated cell observation cannot prove success', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-truncated'); const result = await new SpreadsheetSemanticController(backend).execute(valueEdit(backend, 'long-cell-value'), { maxItems: 1, maxTextBytes: 3 }); assert.equal(result.status, 'verification-failed');
});

test('multi-cell edit is rejected before dispatch', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-multi'); const intent = valueEdit(backend); intent.target.end.column = 1; const result = await new SpreadsheetSemanticController(backend).execute(intent, verificationBounds); assert.equal(result.status, 'rejected'); assert.equal(backend.dispatchCount, 0);
});

test('backend result mutation cannot substitute for model verification', async () => {
  class MutatingBackend extends DeterministicSpreadsheetBackend { override async dispatchSemanticEdit(intent: Parameters<DeterministicSpreadsheetBackend['dispatchSemanticEdit']>[0]): Promise<SpreadsheetDispatchResult> { const r = await super.dispatchSemanticEdit(intent); r.revision = -1; return r; } }
  const backend = new MutatingBackend('sheet-result'); assert.equal((await new SpreadsheetSemanticController(backend).execute(valueEdit(backend), verificationBounds)).status, 'verified');
});

test('backend that mutates then throws is uncertain and not replayed', async () => {
  class MutateThenThrowBackend extends DeterministicSpreadsheetBackend { override async dispatchSemanticEdit(intent: Parameters<DeterministicSpreadsheetBackend['dispatchSemanticEdit']>[0]): Promise<SpreadsheetDispatchResult> { await super.dispatchSemanticEdit(intent); throw new Error('lost after dispatch'); } }
  const backend = new MutateThenThrowBackend('sheet-throw'); const result = await new SpreadsheetSemanticController(backend).execute(valueEdit(backend, 'once'), verificationBounds);
  assert.equal(result.status, 'uncertain'); assert.equal(result.dispatch, 'uncertain'); assert.equal(backend.dispatchCount, 1); if (result.status === 'uncertain') assert.equal(result.verification.status, 'verified');
});

test('explicit uncertain dispatch is never automatically replayed', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-uncertain'); backend.markNextDispatchUncertain(); const result = await new SpreadsheetSemanticController(backend).execute(valueEdit(backend), verificationBounds); assert.equal(result.status, 'uncertain'); assert.equal(backend.dispatchCount, 1);
});
