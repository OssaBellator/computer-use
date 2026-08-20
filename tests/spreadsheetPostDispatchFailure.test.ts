// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { SetCellValueIntent } from '../src/computer/documentModels.js';
import { DeterministicSpreadsheetBackend, SpreadsheetSemanticController } from '../src/application/spreadsheetSemanticAdapter.js';

const bounds = { maxItems: 4, maxTextBytes: 256 };
function edit(backend: DeterministicSpreadsheetBackend): SetCellValueIntent {
  return { kind: 'set-cell-value', intentId: 'post-dispatch-sheet', document: backend.currentDocument(), effect: 'local-reversible-edit', target: { sheet: backend.sheetRef(), start: { row: 0, column: 0 }, end: { row: 0, column: 1 } }, value: 'Q' };
}

test('post-dispatch cell observation exception becomes insufficient verification', async () => {
  class ThrowingObservationBackend extends DeterministicSpreadsheetBackend {
    override async observeCells(): ReturnType<DeterministicSpreadsheetBackend['observeCells']> {
      throw new Error('cell model unavailable after dispatch');
    }
  }
  const backend = new ThrowingObservationBackend('sheet-observation-failure');
  const result = await new SpreadsheetSemanticController(backend).execute(edit(backend), bounds);
  assert.equal(result.status, 'verification-failed');
  assert.equal(result.dispatch, 'dispatched');
  assert.equal(backend.dispatchCount, 1);
  if (result.status === 'verification-failed') {
    assert.equal(result.verification.status, 'insufficient-observation');
    assert.deepEqual(result.verification.evidence, ['post-dispatch-observation-failed']);
  }
});

test('post-dispatch verification identity exception is contained', async () => {
  class ThrowingSecondIdentityBackend extends DeterministicSpreadsheetBackend {
    private reads = 0;
    override async readIdentity(): ReturnType<DeterministicSpreadsheetBackend['readIdentity']> {
      this.reads += 1;
      if (this.reads > 1) throw new Error('sheet identity unavailable after dispatch');
      return super.readIdentity();
    }
  }
  const backend = new ThrowingSecondIdentityBackend('sheet-identity-failure');
  const result = await new SpreadsheetSemanticController(backend).execute(edit(backend), bounds);
  assert.equal(result.status, 'verification-failed');
  assert.equal(result.dispatch, 'dispatched');
  assert.equal(backend.dispatchCount, 1);
  if (result.status === 'verification-failed') assert.deepEqual(result.verification.evidence, ['post-dispatch-observation-failed']);
});

test('uncertain spreadsheet dispatch remains uncertain when verification acquisition fails', async () => {
  class ThrowingObservationBackend extends DeterministicSpreadsheetBackend {
    override async observeCells(): ReturnType<DeterministicSpreadsheetBackend['observeCells']> {
      throw new Error('verification channel unavailable');
    }
  }
  const backend = new ThrowingObservationBackend('sheet-uncertain-verification');
  backend.markNextDispatchUncertain();
  const result = await new SpreadsheetSemanticController(backend).execute(edit(backend), bounds);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.dispatch, 'uncertain');
  assert.equal(backend.dispatchCount, 1);
  if (result.status === 'uncertain') assert.deepEqual(result.verification.evidence, ['post-dispatch-observation-failed']);
});
