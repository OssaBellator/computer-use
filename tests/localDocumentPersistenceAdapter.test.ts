// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { ExportDocumentIntent, PublishDocumentIntent, SaveDocumentIntent } from '../src/computer/documentModels.js';
import { DeterministicLocalDocumentPersistenceBackend, LocalDocumentPersistenceController, type LocalSaveDispatchResult } from '../src/application/localDocumentPersistenceAdapter.js';

function save(backend: DeterministicLocalDocumentPersistenceBackend): SaveDocumentIntent {
  return { kind: 'save-document', intentId: 'local-save-1', document: backend.currentDocument(), effect: 'local-persistence' };
}

test('save local export external export and publish classifications remain distinct', () => {
  const backend = new DeterministicLocalDocumentPersistenceBackend('effects'); const controller = new LocalDocumentPersistenceController(backend); const document = backend.currentDocument();
  const localExport: ExportDocumentIntent = { kind: 'export-document', intentId: 'local', document, effect: 'local-persistence', format: 'txt', destination: { kind: 'local-artifact', artifactId: 'a' } };
  const externalExport: ExportDocumentIntent = { kind: 'export-document', intentId: 'external', document, effect: 'external-publication', format: 'txt', destination: { kind: 'external-target', targetId: 'r' } };
  const publish: PublishDocumentIntent = { kind: 'publish-document', intentId: 'publish', document, effect: 'external-publication', destinationId: 'r' };
  assert.equal(controller.classify(save(backend)), 'local-persistence'); assert.equal(controller.classify(localExport), 'local-persistence'); assert.equal(controller.classify(externalExport), 'external-publication'); assert.equal(controller.classify(publish), 'external-publication'); assert.equal(backend.dispatchCount, 0);
});

test('document replacement rejects stale save before dispatch', async () => {
  class B extends DeterministicLocalDocumentPersistenceBackend { private once = true; override async readRevision(): Promise<number> { const r = await super.readRevision(); if (this.once) { this.once = false; this.replaceDocument(); } return r; } }
  const backend = new B('stale'); const result = await new LocalDocumentPersistenceController(backend).executeSave(save(backend)); assert.equal(result.status, 'rejected'); assert.equal(result.dispatch, 'not-dispatched'); assert.equal(backend.dispatchCount, 0);
});

test('local save dispatches once and verifies saved model revision', async () => {
  const backend = new DeterministicLocalDocumentPersistenceBackend('save', 'word-processing'); const before = await backend.readRevision(); const result = await new LocalDocumentPersistenceController(backend).executeSave(save(backend)); assert.equal(result.status, 'verified'); assert.equal(result.effect, 'local-persistence'); assert.equal(backend.dispatchCount, 1); assert.equal(await backend.readRevision(), before + 1);
});

test('caller save intent is snapshotted before awaits', async () => {
  const backend = new DeterministicLocalDocumentPersistenceBackend('snapshot'); const intent = save(backend); const promise = new LocalDocumentPersistenceController(backend).executeSave(intent); intent.document.generation = 99; intent.intentId = 'mutated'; assert.equal((await promise).status, 'verified'); assert.equal(backend.dispatchCount, 1);
});

test('backend success metadata cannot substitute for saved model verification', async () => {
  class B extends DeterministicLocalDocumentPersistenceBackend { override async dispatchLocalSave(i: SaveDocumentIntent): Promise<LocalSaveDispatchResult> { const r = await super.dispatchLocalSave(i); r.revision = -999; return r; } }
  const backend = new B('result'); assert.equal((await new LocalDocumentPersistenceController(backend).executeSave(save(backend))).status, 'verified'); assert.equal(backend.dispatchCount, 1);
});

test('stale saved-state evidence fails verification', async () => {
  class B extends DeterministicLocalDocumentPersistenceBackend { override async observeSavedState(target: Parameters<DeterministicLocalDocumentPersistenceBackend['observeSavedState']>[0]): ReturnType<DeterministicLocalDocumentPersistenceBackend['observeSavedState']> { const o = await super.observeSavedState(target); return o.kind === 'saved-state' ? { ...o, savedRevision: 0 } : o; } }
  const backend = new B('stale-evidence'); const result = await new LocalDocumentPersistenceController(backend).executeSave(save(backend)); assert.equal(result.status, 'verification-failed'); assert.equal(backend.dispatchCount, 1);
});

test('backend that persists then throws is uncertain and not replayed', async () => {
  class B extends DeterministicLocalDocumentPersistenceBackend { override async dispatchLocalSave(i: SaveDocumentIntent): Promise<LocalSaveDispatchResult> { await super.dispatchLocalSave(i); throw new Error('lost after durable save'); } }
  const backend = new B('throw'); const result = await new LocalDocumentPersistenceController(backend).executeSave(save(backend)); assert.equal(result.status, 'uncertain'); assert.equal(result.dispatch, 'uncertain'); assert.equal(backend.dispatchCount, 1); if (result.status === 'uncertain') assert.equal(result.verification.status, 'verified');
});

test('explicit uncertain save is never automatically replayed', async () => {
  const backend = new DeterministicLocalDocumentPersistenceBackend('uncertain'); backend.markNextDispatchUncertain(); const result = await new LocalDocumentPersistenceController(backend).executeSave(save(backend)); assert.equal(result.status, 'uncertain'); assert.equal(backend.dispatchCount, 1);
});
