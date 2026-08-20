// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { RemoveStructuredObjectIntent, ReorderStructuredObjectIntent } from '../src/computer/documentModels.js';
import {
  DeterministicPresentationBackend,
  PresentationSemanticController,
  type PresentationDispatchResult,
} from '../src/application/presentationSemanticAdapter.js';

const completeBounds = { maxItems: 16, maxTextBytes: 1024 };

function reorder(
  backend: DeterministicPresentationBackend,
  targetIndex = 0,
  beforeEntityId?: string,
): ReorderStructuredObjectIntent {
  return {
    kind: 'reorder-structured-object',
    intentId: 'presentation-reorder-1',
    document: backend.currentDocument(),
    effect: 'local-reversible-edit',
    target: backend.objectRef(targetIndex),
    ...(beforeEntityId === undefined ? {} : { beforeEntityId }),
  };
}

function remove(backend: DeterministicPresentationBackend, targetIndex = 0): RemoveStructuredObjectIntent {
  return {
    kind: 'remove-structured-object',
    intentId: 'presentation-remove-1',
    document: backend.currentDocument(),
    effect: 'local-reversible-edit',
    target: backend.objectRef(targetIndex),
  };
}

test('document replacement rejects stale presentation intent before dispatch', async () => {
  class ReplacingBackend extends DeterministicPresentationBackend {
    private replaceBeforeIdentity = true;
    override async observeObjectOrder(
      container: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[0],
      bounds: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[1],
    ): ReturnType<DeterministicPresentationBackend['observeObjectOrder']> {
      const observed = await super.observeObjectOrder(container, bounds);
      if (this.replaceBeforeIdentity) {
        this.replaceBeforeIdentity = false;
        this.replaceDocument();
      }
      return observed;
    }
  }

  const backend = new ReplacingBackend('presentation-doc-replace');
  const result = await new PresentationSemanticController(backend).execute(reorder(backend), completeBounds);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'document-generation-stale');
  assert.equal(backend.dispatchCount, 0);
});

test('fresh revalidation rejects stale presentation object before dispatch', async () => {
  class ReplacingObjectBackend extends DeterministicPresentationBackend {
    private replaceBeforeIdentity = true;
    override async observeObjectOrder(
      container: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[0],
      bounds: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[1],
    ): ReturnType<DeterministicPresentationBackend['observeObjectOrder']> {
      const observed = await super.observeObjectOrder(container, bounds);
      if (this.replaceBeforeIdentity) {
        this.replaceBeforeIdentity = false;
        this.replaceObject(0);
      }
      return observed;
    }
  }

  const backend = new ReplacingObjectBackend('presentation-object-replace');
  const result = await new PresentationSemanticController(backend).execute(reorder(backend), completeBounds);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'entity-generation-stale');
  assert.equal(backend.dispatchCount, 0);
});

test('fresh revalidation rejects stale slide container before dispatch', async () => {
  class ReplacingSlideBackend extends DeterministicPresentationBackend {
    private replaceBeforeIdentity = true;
    override async observeObjectOrder(
      container: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[0],
      bounds: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[1],
    ): ReturnType<DeterministicPresentationBackend['observeObjectOrder']> {
      const observed = await super.observeObjectOrder(container, bounds);
      if (this.replaceBeforeIdentity) {
        this.replaceBeforeIdentity = false;
        this.replaceSlide();
      }
      return observed;
    }
  }

  const backend = new ReplacingSlideBackend('presentation-slide-replace');
  const result = await new PresentationSemanticController(backend).execute(reorder(backend), completeBounds);
  assert.equal(result.status, 'rejected');
  assert.equal(result.reason, 'entity-generation-stale');
  assert.equal(backend.dispatchCount, 0);
});

test('truncated pre-edit object order is insufficient authority and prevents dispatch', async () => {
  const backend = new DeterministicPresentationBackend('presentation-preflight-bounds');
  const result = await new PresentationSemanticController(backend).execute(
    reorder(backend, 0),
    { maxItems: 1, maxTextBytes: 1024 },
  );
  assert.equal(result.status, 'rejected');
  assert.match(result.reason, /complete presentation object order/);
  assert.equal(backend.dispatchCount, 0);
});

test('native reorder dispatches exactly once and verifies full resulting model order', async () => {
  const backend = new DeterministicPresentationBackend('presentation-reorder', ['a', 'b', 'c']);
  const before = await backend.readRevision();
  const result = await new PresentationSemanticController(backend).execute(reorder(backend, 0, 'c'), completeBounds);
  assert.equal(result.status, 'verified');
  assert.equal(result.dispatch, 'dispatched');
  assert.deepEqual(result.verification.evidence, ['entity-order-model-matches']);
  assert.deepEqual(backend.objectIds(), ['b', 'a', 'c']);
  assert.equal(backend.dispatchCount, 1);
  assert.equal(await backend.readRevision(), before + 1);
});

test('native removal verifies full resulting object order without requiring removed target freshness', async () => {
  const backend = new DeterministicPresentationBackend('presentation-remove', ['a', 'b', 'c']);
  const result = await new PresentationSemanticController(backend).execute(remove(backend, 1), completeBounds);
  assert.equal(result.status, 'verified');
  assert.deepEqual(backend.objectIds(), ['a', 'c']);
  assert.deepEqual(result.verification.evidence, ['entity-order-model-matches']);
  assert.equal(backend.dispatchCount, 1);
});

test('caller-owned presentation intent is snapshotted before awaits', async () => {
  const backend = new DeterministicPresentationBackend('presentation-snapshot', ['a', 'b', 'c']);
  const intent = reorder(backend, 0, 'c');
  const promise = new PresentationSemanticController(backend).execute(intent, completeBounds);
  intent.target.generation = 99;
  intent.beforeEntityId = 'b';
  const result = await promise;
  assert.equal(result.status, 'verified');
  assert.deepEqual(backend.objectIds(), ['b', 'a', 'c']);
});

test('truncated post-edit observation cannot prove successful presentation reorder', async () => {
  class TruncatingVerificationBackend extends DeterministicPresentationBackend {
    private calls = 0;
    override async observeObjectOrder(
      container: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[0],
      bounds: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[1],
    ): ReturnType<DeterministicPresentationBackend['observeObjectOrder']> {
      this.calls += 1;
      return super.observeObjectOrder(container, this.calls === 1 ? bounds : { maxItems: 1, maxTextBytes: bounds.maxTextBytes });
    }
  }

  const backend = new TruncatingVerificationBackend('presentation-post-truncated', ['a', 'b', 'c']);
  const result = await new PresentationSemanticController(backend).execute(reorder(backend, 0, 'c'), completeBounds);
  assert.equal(result.status, 'verification-failed');
  assert.equal(result.dispatch, 'dispatched');
  assert.equal(result.verification.status, 'insufficient-observation');
  assert.deepEqual(result.verification.evidence, ['entity-order-observation-truncated']);
  assert.equal(backend.dispatchCount, 1);
});

test('backend dispatch result mutation cannot substitute for presentation model verification', async () => {
  class MutatingResultBackend extends DeterministicPresentationBackend {
    override async dispatchSemanticEdit(
      intent: Parameters<DeterministicPresentationBackend['dispatchSemanticEdit']>[0],
    ): Promise<PresentationDispatchResult> {
      const result = await super.dispatchSemanticEdit(intent);
      result.revision = -99;
      return result;
    }
  }

  const backend = new MutatingResultBackend('presentation-result-isolation', ['a', 'b', 'c']);
  const result = await new PresentationSemanticController(backend).execute(reorder(backend, 0, 'c'), completeBounds);
  assert.equal(result.status, 'verified');
  assert.equal(result.verification.status, 'verified');
  assert.equal(backend.dispatchCount, 1);
});

test('uncertain presentation dispatch is never automatically replayed', async () => {
  const backend = new DeterministicPresentationBackend('presentation-uncertain', ['a', 'b', 'c']);
  backend.markNextDispatchUncertain();
  const result = await new PresentationSemanticController(backend).execute(reorder(backend, 0, 'c'), completeBounds);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.dispatch, 'uncertain');
  assert.equal(result.verification.status, 'verified');
  assert.equal(backend.dispatchCount, 1);
});
