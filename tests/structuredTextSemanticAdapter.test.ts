// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { ExportDocumentIntent, InsertTextIntent, PublishDocumentIntent, ReplaceTextIntent, SaveDocumentIntent } from '../src/computer/documentModels.js';
import { DeterministicStructuredTextBackend, StructuredTextSemanticController, type StructuredTextDispatchResult } from '../src/application/structuredTextSemanticAdapter.js';

const verificationBounds = { maxItems: 1, maxTextBytes: 256 };
function insertion(backend: DeterministicStructuredTextBackend, text = 'X'): InsertTextIntent {
  return { kind: 'insert-text', intentId: 'insert-1', document: backend.currentDocument(), effect: 'local-reversible-edit', target: backend.sectionRef(), at: 1, text };
}

test('document replacement rejects stale generation before dispatch', async () => {
  class ReplacingBackend extends DeterministicStructuredTextBackend {
    private once = true;
    override async readRevision(): Promise<number> { const r = await super.readRevision(); if (this.once) { this.once = false; this.replaceDocument(); } return r; }
  }
  const backend = new ReplacingBackend('doc-replace', ['abc']);
  const result = await new StructuredTextSemanticController(backend).execute(insertion(backend), verificationBounds);
  assert.equal(result.status, 'rejected'); assert.equal(result.dispatch, 'not-dispatched'); assert.equal(backend.dispatchCount, 0);
});

test('stale entity generation is rejected immediately before dispatch', async () => {
  class ReplacingSectionBackend extends DeterministicStructuredTextBackend {
    private once = true;
    override async readRevision(): Promise<number> { const r = await super.readRevision(); if (this.once) { this.once = false; this.replaceSection(); } return r; }
  }
  const backend = new ReplacingSectionBackend('doc-entity', ['abc']);
  const result = await new StructuredTextSemanticController(backend).execute(insertion(backend), verificationBounds);
  assert.equal(result.status, 'rejected'); assert.equal(result.dispatch, 'not-dispatched'); assert.equal(backend.dispatchCount, 0);
});

test('observation is bounded by items text bytes and depth', async () => {
  const controller = new StructuredTextSemanticController(new DeterministicStructuredTextBackend('doc-bounds', ['alpha', 'beta', 'gamma']));
  const one = await controller.observe({ maxItems: 1, maxTextBytes: 64, maxDepth: 1 });
  assert.equal(one.sections.length, 1); assert.equal(one.truncated, true); assert.equal(one.omittedSections, 2);
  const shallow = await controller.observe({ maxItems: 3, maxTextBytes: 64, maxDepth: 0 });
  assert.equal(shallow.sections.every(section => section.text === undefined), true); assert.equal(shallow.truncated, true);
});

test('native insertion dispatches once and verifies model revision and text', async () => {
  const backend = new DeterministicStructuredTextBackend('doc-insert', ['abc']);
  const before = await backend.readRevision();
  const result = await new StructuredTextSemanticController(backend).execute(insertion(backend, 'XYZ'), verificationBounds);
  assert.equal(result.status, 'verified'); assert.equal(backend.dispatchCount, 1); assert.equal(await backend.readRevision(), before + 1);
});

test('native replacement verifies resulting model state', async () => {
  const backend = new DeterministicStructuredTextBackend('doc-replace-text', ['hello world']);
  const intent: ReplaceTextIntent = { kind: 'replace-text', intentId: 'replace-1', document: backend.currentDocument(), effect: 'local-reversible-edit', target: backend.sectionRef(), range: { start: 6, end: 11 }, text: 'model' };
  const result = await new StructuredTextSemanticController(backend).execute(intent, verificationBounds);
  assert.equal(result.status, 'verified'); assert.equal(backend.dispatchCount, 1);
});

test('caller edit material is snapshotted before awaits', async () => {
  const backend = new DeterministicStructuredTextBackend('doc-snapshot', ['abc']);
  const intent = insertion(backend, 'original');
  const promise = new StructuredTextSemanticController(backend).execute(intent, verificationBounds);
  intent.text = 'mutated'; intent.target.generation = 99;
  const result = await promise;
  assert.equal(result.status, 'verified');
});

test('truncated verification observation cannot prove success', async () => {
  const backend = new DeterministicStructuredTextBackend('doc-truncated', ['abc']);
  const result = await new StructuredTextSemanticController(backend).execute(insertion(backend, 'long-result'), { maxItems: 1, maxTextBytes: 3 });
  assert.equal(result.status, 'verification-failed');
  if (result.status === 'verification-failed') assert.equal(result.verification.status, 'insufficient-observation');
});

test('save local export external export and publish remain distinct effects', async () => {
  const backend = new DeterministicStructuredTextBackend('doc-effects', ['abc']);
  const controller = new StructuredTextSemanticController(backend); const document = backend.currentDocument();
  const save: SaveDocumentIntent = { kind: 'save-document', intentId: 'save', document, effect: 'local-persistence' };
  const localExport: ExportDocumentIntent = { kind: 'export-document', intentId: 'local', document, effect: 'local-persistence', format: 'txt', destination: { kind: 'local-artifact', artifactId: 'a' } };
  const externalExport: ExportDocumentIntent = { kind: 'export-document', intentId: 'external', document, effect: 'external-publication', format: 'txt', destination: { kind: 'external-target', targetId: 'r' } };
  const publish: PublishDocumentIntent = { kind: 'publish-document', intentId: 'publish', document, effect: 'external-publication', destinationId: 'r' };
  assert.equal(controller.classify(save), 'local-persistence'); assert.equal(controller.classify(localExport), 'local-persistence');
  assert.equal(controller.classify(externalExport), 'external-publication'); assert.equal(controller.classify(publish), 'external-publication');
});

test('backend result mutation cannot substitute for model verification', async () => {
  class MutatingResultBackend extends DeterministicStructuredTextBackend {
    override async dispatchSemanticEdit(intent: Parameters<DeterministicStructuredTextBackend['dispatchSemanticEdit']>[0]): Promise<StructuredTextDispatchResult> { const result = await super.dispatchSemanticEdit(intent); result.revision = -999; return result; }
  }
  const backend = new MutatingResultBackend('doc-result', ['abc']);
  const result = await new StructuredTextSemanticController(backend).execute(insertion(backend, 'Q'), verificationBounds);
  assert.equal(result.status, 'verified');
});

test('backend that mutates then throws is uncertain and never replayed', async () => {
  class MutateThenThrowBackend extends DeterministicStructuredTextBackend {
    override async dispatchSemanticEdit(intent: Parameters<DeterministicStructuredTextBackend['dispatchSemanticEdit']>[0]): Promise<StructuredTextDispatchResult> {
      await super.dispatchSemanticEdit(intent);
      throw new Error('transport lost after native dispatch');
    }
  }
  const backend = new MutateThenThrowBackend('doc-throw', ['abc']);
  const result = await new StructuredTextSemanticController(backend).execute(insertion(backend, 'Q'), verificationBounds);
  assert.equal(result.status, 'uncertain'); assert.equal(result.dispatch, 'uncertain'); assert.equal(backend.dispatchCount, 1);
  if (result.status === 'uncertain') assert.equal(result.verification.status, 'verified');
});

test('explicit uncertain side-effect dispatch is never automatically replayed', async () => {
  const backend = new DeterministicStructuredTextBackend('doc-uncertain', ['abc']); backend.markNextDispatchUncertain();
  const result = await new StructuredTextSemanticController(backend).execute(insertion(backend, 'Q'), verificationBounds);
  assert.equal(result.status, 'uncertain'); assert.equal(backend.dispatchCount, 1);
});
