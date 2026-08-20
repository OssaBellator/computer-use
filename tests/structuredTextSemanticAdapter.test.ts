// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { InsertTextIntent, PublishDocumentIntent, ReplaceTextIntent, SaveDocumentIntent } from '../src/computer/documentModels.js';
import {
  DeterministicStructuredTextBackend,
  StructuredTextSemanticController,
  type StructuredTextDispatchResult,
} from '../src/application/structuredTextSemanticAdapter.js';

const verificationBounds = { maxItems: 1, maxTextBytes: 256 };

function insertion(backend: DeterministicStructuredTextBackend, text = 'X'): InsertTextIntent {
  const document = backend.currentDocument();
  return {
    kind: 'insert-text',
    intentId: 'insert-1',
    document,
    effect: 'local-reversible-edit',
    target: backend.sectionRef(),
    at: 1,
    text,
  };
}

test('document replacement advances generation and stale intent is rejected before dispatch', async () => {
  class ReplacingBackend extends DeterministicStructuredTextBackend {
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
  const backend = new ReplacingBackend('doc-replace', ['abc']);
  const original = backend.currentDocument();
  const controller = new StructuredTextSemanticController(backend);
  const result = await controller.execute(insertion(backend), verificationBounds);
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(result.reason, 'document-generation-stale');
  assert.equal(backend.currentDocument().generation, original.generation + 1);
  assert.equal(backend.dispatchCount, 0);
});

test('fresh revalidation rejects stale entity generation immediately before dispatch', async () => {
  class ReplacingSectionBackend extends DeterministicStructuredTextBackend {
    private replaceBeforeIdentity = true;
    override async readRevision(): Promise<number> {
      const revision = await super.readRevision();
      if (this.replaceBeforeIdentity) {
        this.replaceBeforeIdentity = false;
        this.replaceSection();
      }
      return revision;
    }
  }
  const backend = new ReplacingSectionBackend('doc-entity', ['abc']);
  const intent = insertion(backend);
  const controller = new StructuredTextSemanticController(backend);
  const result = await controller.execute(intent, verificationBounds);
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(result.reason, 'entity-generation-stale');
  assert.equal(backend.dispatchCount, 0);
});

test('document observation is bounded by item count, text bytes, and depth', async () => {
  const backend = new DeterministicStructuredTextBackend('doc-bounds', ['alpha', 'beta', 'gamma']);
  const controller = new StructuredTextSemanticController(backend);
  const one = await controller.observe({ maxItems: 1, maxTextBytes: 64, maxDepth: 1 });
  assert.equal(one.sections.length, 1);
  assert.equal(one.totalSections, 3);
  assert.equal(one.truncated, true);
  assert.equal(one.omittedSections, 2);
  assert.equal(one.sections[0]?.text, 'alpha');

  const shallow = await controller.observe({ maxItems: 3, maxTextBytes: 64, maxDepth: 0 });
  assert.equal(shallow.sections.length, 3);
  assert.equal(shallow.sections.every(section => section.text === undefined), true);
  assert.equal(shallow.truncated, true);

  const bytes = await controller.observe({ maxItems: 3, maxTextBytes: 16, maxDepth: 1 });
  assert.equal(bytes.sections.length < 3, true);
  assert.equal(bytes.truncated, true);
});

test('native insertion dispatches exactly once and verifies resulting model revision and text', async () => {
  const backend = new DeterministicStructuredTextBackend('doc-insert', ['abc']);
  const controller = new StructuredTextSemanticController(backend);
  const before = await backend.readRevision();
  const result = await controller.execute(insertion(backend, 'XYZ'), verificationBounds);
  assert.equal(result.status, 'verified');
  assert.equal(result.dispatch, 'dispatched');
  assert.equal(result.verification.status, 'verified');
  assert.deepEqual(result.verification.evidence, ['text-model-matches']);
  assert.equal(backend.dispatchCount, 1);
  assert.equal(await backend.readRevision(), before + 1);
  const observed = await backend.observeText(backend.sectionRef(), { start: 0, end: 6 }, verificationBounds);
  assert.equal(observed.kind, 'text');
  if (observed.kind === 'text') assert.equal(observed.observation.text, 'aXYZbc');
});

test('native replacement verifies the replacement range in resulting model state', async () => {
  const backend = new DeterministicStructuredTextBackend('doc-replace-text', ['hello world']);
  const document = backend.currentDocument();
  const intent: ReplaceTextIntent = {
    kind: 'replace-text',
    intentId: 'replace-1',
    document,
    effect: 'local-reversible-edit',
    target: backend.sectionRef(),
    range: { start: 6, end: 11 },
    text: 'model',
  };
  const result = await new StructuredTextSemanticController(backend).execute(intent, verificationBounds);
  assert.equal(result.status, 'verified');
  assert.equal(backend.dispatchCount, 1);
  const observed = await backend.observeText(backend.sectionRef(), { start: 0, end: 11 }, verificationBounds);
  assert.equal(observed.kind, 'text');
  if (observed.kind === 'text') assert.equal(observed.observation.text, 'hello model');
});

test('caller edit material is snapshotted before awaits', async () => {
  const backend = new DeterministicStructuredTextBackend('doc-snapshot', ['abc']);
  const intent = insertion(backend, 'original');
  const promise = new StructuredTextSemanticController(backend).execute(intent, verificationBounds);
  intent.text = 'mutated-after-call';
  intent.target.generation = 99;
  const result = await promise;
  assert.equal(result.status, 'verified');
  assert.equal(backend.dispatchCount, 1);
  const observed = await backend.observeText(backend.sectionRef(), { start: 1, end: 9 }, verificationBounds);
  assert.equal(observed.kind, 'text');
  if (observed.kind === 'text') assert.equal(observed.observation.text, 'original');
});

test('truncated verification observation cannot prove semantic edit success', async () => {
  const backend = new DeterministicStructuredTextBackend('doc-truncated', ['abc']);
  const result = await new StructuredTextSemanticController(backend).execute(
    insertion(backend, 'long-result'),
    { maxItems: 1, maxTextBytes: 3 },
  );
  assert.equal(result.status, 'verification-failed');
  assert.equal(result.dispatch, 'dispatched');
  assert.equal(result.verification.status, 'insufficient-observation');
  assert.deepEqual(result.verification.evidence, ['text-observation-not-complete']);
  assert.equal(backend.dispatchCount, 1);
});

test('save remains local persistence while publish remains external publication', async () => {
  const backend = new DeterministicStructuredTextBackend('doc-effects', ['abc']);
  const controller = new StructuredTextSemanticController(backend);
  const save: SaveDocumentIntent = {
    kind: 'save-document',
    intentId: 'save-1',
    document: backend.currentDocument(),
    effect: 'local-persistence',
  };
  const publish: PublishDocumentIntent = {
    kind: 'publish-document',
    intentId: 'publish-1',
    document: backend.currentDocument(),
    effect: 'external-publication',
    destinationId: 'remote-destination',
  };
  assert.equal(controller.classify(save), 'local-persistence');
  assert.equal(controller.classify(publish), 'external-publication');
  const result = await controller.execute(save, verificationBounds);
  assert.equal(result.status, 'verified');
  assert.equal(result.effect, 'local-persistence');
  assert.equal(backend.dispatchCount, 1);
});

test('backend result mutation cannot substitute for model verification', async () => {
  class MutatingResultBackend extends DeterministicStructuredTextBackend {
    override async dispatchSemanticEdit(intent: Parameters<DeterministicStructuredTextBackend['dispatchSemanticEdit']>[0]): Promise<StructuredTextDispatchResult> {
      const result = await super.dispatchSemanticEdit(intent);
      result.revision = -999;
      return result;
    }
  }
  const backend = new MutatingResultBackend('doc-result-isolation', ['abc']);
  const result = await new StructuredTextSemanticController(backend).execute(insertion(backend, 'Q'), verificationBounds);
  assert.equal(result.status, 'verified');
  assert.equal(result.verification.status, 'verified');
  assert.equal(backend.dispatchCount, 1);
});

test('uncertain side-effect dispatch is never automatically replayed', async () => {
  const backend = new DeterministicStructuredTextBackend('doc-uncertain', ['abc']);
  backend.markNextDispatchUncertain();
  const result = await new StructuredTextSemanticController(backend).execute(insertion(backend, 'Q'), verificationBounds);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.dispatch, 'uncertain');
  assert.equal(result.verification.status, 'verified');
  assert.equal(backend.dispatchCount, 1);
});
