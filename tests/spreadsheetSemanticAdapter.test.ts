// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { SetCellFormulaIntent, SetCellValueIntent } from '../src/computer/documentModels.js';
import {
  DeterministicSpreadsheetBackend,
  SpreadsheetSemanticController,
  type SpreadsheetDispatchResult,
} from '../src/application/spreadsheetSemanticAdapter.js';

const verificationBounds = { maxItems: 1, maxTextBytes: 256 };

function valueEdit(backend: DeterministicSpreadsheetBackend, value: string | number | boolean | null = 'updated'): SetCellValueIntent {
  return {
    kind: 'set-cell-value',
    intentId: 'cell-value-1',
    document: backend.currentDocument(),
    effect: 'local-reversible-edit',
    target: backend.cellRange(0, 0),
    value,
  };
}

test('document replacement advances generation and rejects stale cell edit before dispatch', async () => {
  class ReplacingBackend extends DeterministicSpreadsheetBackend {
    private replaceBeforeIdentity = true;
    override async readRevision(): Promise<number> {
      const revision = await super.readRevision();
      if (this.replaceBeforeIdentity) {
        this.replaceBeforeIdentity = false;
        this.replaceDocument();
      }
      return revision;
    }
  }

  const backend = new ReplacingBackend('sheet-doc-replace');
  const intent = valueEdit(backend);
  const result = await new SpreadsheetSemanticController(backend).execute(intent, verificationBounds);
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(result.reason, 'document-generation-stale');
  assert.equal(backend.dispatchCount, 0);
});

test('fresh generation revalidation rejects a stale sheet immediately before dispatch', async () => {
  class ReplacingSheetBackend extends DeterministicSpreadsheetBackend {
    private replaceBeforeIdentity = true;
    override async readRevision(): Promise<number> {
      const revision = await super.readRevision();
      if (this.replaceBeforeIdentity) {
        this.replaceBeforeIdentity = false;
        this.replaceSheet();
      }
      return revision;
    }
  }

  const backend = new ReplacingSheetBackend('sheet-entity-replace');
  const result = await new SpreadsheetSemanticController(backend).execute(valueEdit(backend), verificationBounds);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'entity-generation-stale');
  assert.equal(backend.dispatchCount, 0);
});

test('cell observation is bounded by item count and text bytes', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-bounds');
  backend.seedCell({ row: 0, column: 0 }, { kind: 'value', value: 'alpha' });
  backend.seedCell({ row: 0, column: 1 }, { kind: 'value', value: 'beta' });
  const sheet = backend.sheetRef();
  const range = { sheet, start: { row: 0, column: 0 }, end: { row: 0, column: 1 } };

  const byItems = await backend.observeCells(range, { maxItems: 1, maxTextBytes: 64 });
  assert.equal(byItems.kind, 'cells');
  if (byItems.kind === 'cells') {
    assert.equal(byItems.cells.length, 1);
    assert.equal(byItems.truncated, true);
  }

  const byBytes = await backend.observeCells(range, { maxItems: 2, maxTextBytes: 5 });
  assert.equal(byBytes.kind, 'cells');
  if (byBytes.kind === 'cells') {
    assert.equal(byBytes.cells.length, 1);
    assert.equal(byBytes.truncated, true);
  }
});

test('native cell value update dispatches exactly once and verifies model revision/input', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-value');
  const before = await backend.readRevision();
  const result = await new SpreadsheetSemanticController(backend).execute(valueEdit(backend, 42), verificationBounds);
  assert.equal(result.status, 'verified');
  assert.equal(result.dispatch, 'dispatched');
  assert.deepEqual(result.verification.evidence, ['cell-input-model-matches']);
  assert.equal(backend.dispatchCount, 1);
  assert.equal(await backend.readRevision(), before + 1);

  const observed = await backend.observeCells(backend.cellRange(0, 0), verificationBounds);
  assert.equal(observed.kind, 'cells');
  if (observed.kind === 'cells') assert.deepEqual(observed.cells[0]?.input, { kind: 'value', value: 42 });
});

test('native formula update verifies formula input rather than displayed value', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-formula');
  const intent: SetCellFormulaIntent = {
    kind: 'set-cell-formula',
    intentId: 'cell-formula-1',
    document: backend.currentDocument(),
    effect: 'local-reversible-edit',
    target: backend.cellRange(2, 3),
    formula: 'SUM(A1:A3)',
  };

  const result = await new SpreadsheetSemanticController(backend).execute(intent, verificationBounds);
  assert.equal(result.status, 'verified');
  const observed = await backend.observeCells(backend.cellRange(2, 3), verificationBounds);
  assert.equal(observed.kind, 'cells');
  if (observed.kind === 'cells') assert.deepEqual(observed.cells[0]?.input, { kind: 'formula', formula: 'SUM(A1:A3)' });
});

test('caller-owned cell intent is snapshotted before awaits', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-snapshot');
  const intent = valueEdit(backend, 'original');
  const promise = new SpreadsheetSemanticController(backend).execute(intent, verificationBounds);
  intent.value = 'mutated-after-call';
  intent.target.sheet.generation = 99;
  const result = await promise;
  assert.equal(result.status, 'verified');

  const observed = await backend.observeCells(backend.cellRange(0, 0), verificationBounds);
  assert.equal(observed.kind, 'cells');
  if (observed.kind === 'cells') assert.deepEqual(observed.cells[0]?.input, { kind: 'value', value: 'original' });
});

test('truncated cell observation cannot prove semantic edit success', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-truncated');
  const result = await new SpreadsheetSemanticController(backend).execute(
    valueEdit(backend, 'long-cell-value'),
    { maxItems: 1, maxTextBytes: 3 },
  );
  assert.equal(result.status, 'verification-failed');
  assert.equal(result.dispatch, 'dispatched');
  assert.equal(result.verification.status, 'insufficient-observation');
  assert.deepEqual(result.verification.evidence, ['cell-observation-truncated']);
  assert.equal(backend.dispatchCount, 1);
});

test('multi-cell edit is rejected before dispatch to preserve exact verification semantics', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-multi-cell');
  const intent = valueEdit(backend, 'x');
  intent.target.end.column = 1;
  const result = await new SpreadsheetSemanticController(backend).execute(intent, verificationBounds);
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.match(result.reason, /single-cell target/);
  assert.equal(backend.dispatchCount, 0);
});

test('backend dispatch-result mutation cannot substitute for model verification', async () => {
  class MutatingResultBackend extends DeterministicSpreadsheetBackend {
    override async dispatchSemanticEdit(
      intent: Parameters<DeterministicSpreadsheetBackend['dispatchSemanticEdit']>[0],
    ): Promise<SpreadsheetDispatchResult> {
      const result = await super.dispatchSemanticEdit(intent);
      result.revision = -1;
      return result;
    }
  }

  const backend = new MutatingResultBackend('sheet-result-isolation');
  const result = await new SpreadsheetSemanticController(backend).execute(valueEdit(backend, 'safe'), verificationBounds);
  assert.equal(result.status, 'verified');
  assert.equal(result.verification.status, 'verified');
  assert.equal(backend.dispatchCount, 1);
});

test('uncertain spreadsheet dispatch is never automatically replayed', async () => {
  const backend = new DeterministicSpreadsheetBackend('sheet-uncertain');
  backend.markNextDispatchUncertain();
  const result = await new SpreadsheetSemanticController(backend).execute(valueEdit(backend, 'once'), verificationBounds);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.dispatch, 'uncertain');
  assert.equal(result.verification.status, 'verified');
  assert.equal(backend.dispatchCount, 1);
});
