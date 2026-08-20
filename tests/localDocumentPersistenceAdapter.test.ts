// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { ExportDocumentIntent, PublishDocumentIntent, SaveDocumentIntent } from '../src/computer/documentModels.js';
import {
  DeterministicLocalDocumentPersistenceBackend,
  LocalDocumentPersistenceController,
  type LocalSaveDispatchResult,
} from '../src/application/localDocumentPersistenceAdapter.js';

function save(backend: DeterministicLocalDocumentPersistenceBackend): SaveDocumentIntent {
  return {
    kind: 'save-document',
    intentId: 'local-save-1',
    document: backend.currentDocument(),
    effect: 'local-persistence',
  };
}

test('local persistence controller keeps save, local export, external export, and publish classifications distinct', () => {
  const backend = new DeterministicLocalDocumentPersistenceBackend('persistence-effects');
  const controller = new LocalDocumentPersistenceController(backend);
  const document = backend.currentDocument();
  const localExport: ExportDocumentIntent = {
    kind: 'export-document',
    intentId: 'local-export-1',
    document,
    effect: 'local-persistence',
    format: 'txt',
    destination: { kind: 'local-artifact', artifactId: 'artifact-1' },
  };
  const externalExport: ExportDocumentIntent = {
    kind: 'export-document',
    intentId: 'external-export-1',
    document,
    effect: 'external-publication',
    format: 'txt',
    destination: { kind: 'external-target', targetId: 'external-1' },
  };
  const publish: PublishDocumentIntent = {
    kind: 'publish-document',
    intentId: 'publish-1',
    document,
    effect: 'external-publication',
    destinationId: 'published-target',
  };

  assert.equal(controller.classify(save(backend)), 'local-persistence');
  assert.equal(controller.classify(localExport), 'local-persistence');
  assert.equal(controller.classify(externalExport), 'external-publication');
  assert.equal(controller.classify(publish), 'external-publication');
  assert.equal(backend.dispatchCount, 0);
});

test('document replacement rejects stale save generation immediately before dispatch', async () => {
  class ReplacingBackend extends DeterministicLocalDocumentPersistenceBackend {
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

  const backend = new ReplacingBackend('persistence-stale');
  const result = await new LocalDocumentPersistenceController(backend).executeSave(save(backend));
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(result.reason, 'document-generation-stale');
  assert.equal(backend.dispatchCount, 0);
});

test('native local save dispatches exactly once and verifies saved model revision', async () => {
  const backend = new DeterministicLocalDocumentPersistenceBackend('persistence-save', 'word-processing');
  const before = await backend.readRevision();
  const result = await new LocalDocumentPersistenceController(backend).executeSave(save(backend));
  assert.equal(result.status, 'verified');
  assert.equal(result.effect, 'local-persistence');
  assert.equal(result.dispatch, 'dispatched');
  assert.deepEqual(result.verification.evidence, ['saved-model-revision-confirmed']);
  assert.equal(backend.dispatchCount, 1);
  assert.equal(await backend.readRevision(), before + 1);
});

test('caller-owned save intent is snapshotted before awaits', async () => {
  const backend = new DeterministicLocalDocumentPersistenceBackend('persistence-snapshot');
  const intent = save(backend);
  const promise = new LocalDocumentPersistenceController(backend).executeSave(intent);
  intent.document.generation = 99;
  intent.intentId = 'mutated-after-call';
  const result = await promise;
  assert.equal(result.status, 'verified');
  assert.equal(backend.dispatchCount, 1);
});

test('backend success metadata cannot substitute for saved model verification', async () => {
  class MutatingResultBackend extends DeterministicLocalDocumentPersistenceBackend {
    override async dispatchLocalSave(intent: SaveDocumentIntent): Promise<LocalSaveDispatchResult> {
      const result = await super.dispatchLocalSave(intent);
      result.revision = -999;
      return result;
    }
  }

  const backend = new MutatingResultBackend('persistence-result-isolation');
  const result = await new LocalDocumentPersistenceController(backend).executeSave(save(backend));
  assert.equal(result.status, 'verified');
  assert.equal(result.verification.status, 'verified');
  assert.equal(backend.dispatchCount, 1);
});

test('stale saved-state evidence fails verification even after backend reports a save', async () => {
  class StaleEvidenceBackend extends DeterministicLocalDocumentPersistenceBackend {
    override async observeSavedState(
      target: Parameters<DeterministicLocalDocumentPersistenceBackend['observeSavedState']>[0],
    ): ReturnType<DeterministicLocalDocumentPersistenceBackend['observeSavedState']> {
      const observed = await super.observeSavedState(target);
      assert.equal(observed.kind, 'saved-state');
      if (observed.kind !== 'saved-state') return observed;
      return { ...observed, savedRevision: 0 };
    }
  }

  const backend = new StaleEvidenceBackend('persistence-stale-evidence');
  const result = await new LocalDocumentPersistenceController(backend).executeSave(save(backend));
  assert.equal(result.status, 'verification-failed');
  assert.equal(result.dispatch, 'dispatched');
  assert.equal(result.verification.status, 'mismatch');
  assert.deepEqual(result.verification.evidence, ['saved-model-revision-too-old']);
  assert.equal(backend.dispatchCount, 1);
});

test('uncertain local save is never automatically replayed', async () => {
  const backend = new DeterministicLocalDocumentPersistenceBackend('persistence-uncertain');
  backend.markNextDispatchUncertain();
  const result = await new LocalDocumentPersistenceController(backend).executeSave(save(backend));
  assert.equal(result.status, 'uncertain');
  assert.equal(result.dispatch, 'uncertain');
  assert.equal(result.verification.status, 'verified');
  assert.equal(backend.dispatchCount, 1);
});
