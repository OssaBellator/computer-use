// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { EditCodeBufferIntent } from '../src/computer/documentModels.js';
import { CodeBufferSemanticController, DeterministicCodeBufferBackend } from '../src/application/codeBufferSemanticAdapter.js';

const bounds = { maxItems: 1, maxTextBytes: 256 };
function edit(backend: DeterministicCodeBufferBackend): EditCodeBufferIntent {
  const target = backend.bufferRef();
  return { kind: 'edit-code-buffer', intentId: 'post-dispatch-code', document: backend.currentDocument(), effect: 'local-reversible-edit', target, range: { buffer: target, start: { line: 0, column: 1 }, end: { line: 0, column: 2 } }, text: 'Q' };
}

test('invalid verification bounds reject before code dispatch', async () => {
  const backend = new DeterministicCodeBufferBackend('code-invalid-bounds', 'abc');
  const result = await new CodeBufferSemanticController(backend).execute(edit(backend), { maxItems: 0, maxTextBytes: 256 });
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(backend.dispatchCount, 0);
});

test('post-dispatch code observation exception becomes insufficient verification', async () => {
  class ThrowingObservationBackend extends DeterministicCodeBufferBackend {
    override async observeText(): ReturnType<DeterministicCodeBufferBackend['observeText']> {
      throw new Error('code model unavailable after dispatch');
    }
  }
  const backend = new ThrowingObservationBackend('code-observation-failure', 'abc');
  const result = await new CodeBufferSemanticController(backend).execute(edit(backend), bounds);
  assert.equal(result.status, 'verification-failed');
  assert.equal(result.dispatch, 'dispatched');
  assert.equal(backend.dispatchCount, 1);
  if (result.status === 'verification-failed') assert.deepEqual(result.verification.evidence, ['post-dispatch-observation-failed']);
});

test('post-dispatch code identity exception is contained', async () => {
  class ThrowingSecondIdentityBackend extends DeterministicCodeBufferBackend {
    private reads = 0;
    override async readIdentity(): ReturnType<DeterministicCodeBufferBackend['readIdentity']> {
      this.reads += 1;
      if (this.reads > 1) throw new Error('code identity unavailable after dispatch');
      return super.readIdentity();
    }
  }
  const backend = new ThrowingSecondIdentityBackend('code-identity-failure', 'abc');
  const result = await new CodeBufferSemanticController(backend).execute(edit(backend), bounds);
  assert.equal(result.status, 'verification-failed');
  assert.equal(result.dispatch, 'dispatched');
  assert.equal(backend.dispatchCount, 1);
  if (result.status === 'verification-failed') assert.deepEqual(result.verification.evidence, ['post-dispatch-observation-failed']);
});

test('uncertain code dispatch remains uncertain when evidence acquisition fails', async () => {
  class ThrowingObservationBackend extends DeterministicCodeBufferBackend {
    override async observeText(): ReturnType<DeterministicCodeBufferBackend['observeText']> {
      throw new Error('verification channel unavailable');
    }
  }
  const backend = new ThrowingObservationBackend('code-uncertain-verification', 'abc');
  backend.markNextDispatchUncertain();
  const result = await new CodeBufferSemanticController(backend).execute(edit(backend), bounds);
  assert.equal(result.status, 'uncertain');
  assert.equal(result.dispatch, 'uncertain');
  assert.equal(backend.dispatchCount, 1);
  if (result.status === 'uncertain') assert.deepEqual(result.verification.evidence, ['post-dispatch-observation-failed']);
});
