// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { InsertTextIntent } from '../src/computer/documentModels.js';
import { DeterministicStructuredTextBackend, StructuredTextSemanticController } from '../src/application/structuredTextSemanticAdapter.js';

const bounds = { maxItems: 1, maxTextBytes: 256 };
function insertion(backend: DeterministicStructuredTextBackend): InsertTextIntent {
  return { kind: 'insert-text', intentId: 'post-dispatch-test', document: backend.currentDocument(), effect: 'local-reversible-edit', target: backend.sectionRef(), at: 1, text: 'Q' };
}

test('invalid verification bounds reject before semantic dispatch', async () => {
  const backend = new DeterministicStructuredTextBackend('invalid-bounds', ['abc']);
  const result = await new StructuredTextSemanticController(backend).execute(insertion(backend), { maxItems: 0, maxTextBytes: 256 });
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(backend.dispatchCount, 0);
});

test('post-dispatch observation exception becomes insufficient verification rather than escaping', async () => {
  class ThrowingObservationBackend extends DeterministicStructuredTextBackend {
    override async observeText(): ReturnType<DeterministicStructuredTextBackend['observeText']> {
      throw new Error('model observation unavailable after dispatch');
    }
  }
  const backend = new ThrowingObservationBackend('observation-failure', ['abc']);
  const result = await new StructuredTextSemanticController(backend).execute(insertion(backend), bounds);
  assert.equal(result.status, 'verification-failed');
  assert.equal(result.dispatch, 'dispatched');
  assert.equal(backend.dispatchCount, 1);
  if (result.status === 'verification-failed') {
    assert.equal(result.verification.status, 'insufficient-observation');
    assert.deepEqual(result.verification.evidence, ['post-dispatch-observation-failed']);
  }
});

test('post-dispatch verification identity exception is contained as insufficient observation', async () => {
  class ThrowingSecondIdentityBackend extends DeterministicStructuredTextBackend {
    private reads = 0;
    override async readIdentity(): ReturnType<DeterministicStructuredTextBackend['readIdentity']> {
      this.reads += 1;
      if (this.reads > 1) throw new Error('identity unavailable after dispatch');
      return super.readIdentity();
    }
  }
  const backend = new ThrowingSecondIdentityBackend('identity-failure', ['abc']);
  const result = await new StructuredTextSemanticController(backend).execute(insertion(backend), bounds);
  assert.equal(result.status, 'verification-failed');
  assert.equal(result.dispatch, 'dispatched');
  assert.equal(backend.dispatchCount, 1);
  if (result.status === 'verification-failed') assert.deepEqual(result.verification.evidence, ['post-dispatch-observation-failed']);
});

test('uncertain dispatch remains uncertain when post-dispatch evidence acquisition also fails', async () => {
  class ThrowingObservationBackend extends DeterministicStructuredTextBackend {
    override async observeText(): ReturnType<DeterministicStructuredTextBackend['observeText']> {
      throw new Error('verification channel unavailable');
    }
  }
  const backend = new ThrowingObservationBackend('uncertain-observation-failure', ['abc']);
  backend.markNextDispatchUncertain();
  const result = await new StructuredTextSemanticController(backend).execute(insertion(backend), bounds);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.dispatch, 'uncertain');
  assert.equal(backend.dispatchCount, 1);
  if (result.status === 'uncertain') assert.deepEqual(result.verification.evidence, ['post-dispatch-observation-failed']);
});
