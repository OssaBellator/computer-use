// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { RemoveStructuredObjectIntent, ReorderStructuredObjectIntent } from '../src/computer/documentModels.js';
import { DeterministicPresentationBackend, PresentationSemanticController, type PresentationDispatchResult } from '../src/application/presentationSemanticAdapter.js';

const completeBounds = { maxItems: 16, maxTextBytes: 1024 };
function reorder(backend: DeterministicPresentationBackend, targetIndex = 0, beforeEntityId?: string): ReorderStructuredObjectIntent {
  return { kind: 'reorder-structured-object', intentId: 'reorder', document: backend.currentDocument(), effect: 'local-reversible-edit', target: backend.objectRef(targetIndex), ...(beforeEntityId === undefined ? {} : { beforeEntityId }) };
}
function remove(backend: DeterministicPresentationBackend, targetIndex = 0): RemoveStructuredObjectIntent {
  return { kind: 'remove-structured-object', intentId: 'remove', document: backend.currentDocument(), effect: 'local-reversible-edit', target: backend.objectRef(targetIndex) };
}

test('document replacement rejects stale intent before dispatch', async () => {
  class B extends DeterministicPresentationBackend { private once = true; override async observeObjectOrder(c: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[0], b: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[1]): ReturnType<DeterministicPresentationBackend['observeObjectOrder']> { const o = await super.observeObjectOrder(c, b); if (this.once) { this.once = false; this.replaceDocument(); } return o; } }
  const backend = new B('doc'); const result = await new PresentationSemanticController(backend).execute(reorder(backend), completeBounds); assert.equal(result.status, 'rejected'); assert.equal(backend.dispatchCount, 0);
});

test('stale object generation rejects before dispatch', async () => {
  class B extends DeterministicPresentationBackend { private once = true; override async observeObjectOrder(c: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[0], b: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[1]): ReturnType<DeterministicPresentationBackend['observeObjectOrder']> { const o = await super.observeObjectOrder(c, b); if (this.once) { this.once = false; this.replaceObject(0); } return o; } }
  const backend = new B('object'); assert.equal((await new PresentationSemanticController(backend).execute(reorder(backend), completeBounds)).status, 'rejected'); assert.equal(backend.dispatchCount, 0);
});

test('stale slide container rejects before dispatch', async () => {
  class B extends DeterministicPresentationBackend { private once = true; override async observeObjectOrder(c: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[0], b: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[1]): ReturnType<DeterministicPresentationBackend['observeObjectOrder']> { const o = await super.observeObjectOrder(c, b); if (this.once) { this.once = false; this.replaceSlide(); } return o; } }
  const backend = new B('slide'); assert.equal((await new PresentationSemanticController(backend).execute(reorder(backend), completeBounds)).status, 'rejected'); assert.equal(backend.dispatchCount, 0);
});

test('truncated pre-edit order prevents dispatch', async () => {
  const backend = new DeterministicPresentationBackend('preflight'); const result = await new PresentationSemanticController(backend).execute(reorder(backend), { maxItems: 1, maxTextBytes: 1024 }); assert.equal(result.status, 'rejected'); assert.equal(backend.dispatchCount, 0);
});

test('missing reorder anchor is rejected before backend mutation', async () => {
  const backend = new DeterministicPresentationBackend('missing-anchor', ['a', 'b', 'c']); const before = backend.objectIds(); const result = await new PresentationSemanticController(backend).execute(reorder(backend, 0, 'missing'), completeBounds); assert.equal(result.status, 'rejected'); assert.deepEqual(backend.objectIds(), before); assert.equal(backend.dispatchCount, 0);
});

test('native reorder dispatches once and verifies full order', async () => {
  const backend = new DeterministicPresentationBackend('reorder', ['a', 'b', 'c']); const before = await backend.readRevision(); const result = await new PresentationSemanticController(backend).execute(reorder(backend, 0, 'c'), completeBounds); assert.equal(result.status, 'verified'); assert.deepEqual(backend.objectIds(), ['b', 'a', 'c']); assert.equal(await backend.readRevision(), before + 1); assert.equal(backend.dispatchCount, 1);
});

test('native removal verifies surviving container order', async () => {
  const backend = new DeterministicPresentationBackend('remove', ['a', 'b', 'c']); const result = await new PresentationSemanticController(backend).execute(remove(backend, 1), completeBounds); assert.equal(result.status, 'verified'); assert.deepEqual(backend.objectIds(), ['a', 'c']); assert.equal(backend.dispatchCount, 1);
});

test('caller intent is snapshotted before awaits', async () => {
  const backend = new DeterministicPresentationBackend('snap', ['a', 'b', 'c']); const intent = reorder(backend, 0, 'c'); const promise = new PresentationSemanticController(backend).execute(intent, completeBounds); intent.target.generation = 99; intent.beforeEntityId = 'b'; assert.equal((await promise).status, 'verified'); assert.deepEqual(backend.objectIds(), ['b', 'a', 'c']);
});

test('truncated post-edit observation cannot prove success', async () => {
  class B extends DeterministicPresentationBackend { private calls = 0; override async observeObjectOrder(c: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[0], b: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[1]): ReturnType<DeterministicPresentationBackend['observeObjectOrder']> { this.calls += 1; return super.observeObjectOrder(c, this.calls === 1 ? b : { maxItems: 1, maxTextBytes: b.maxTextBytes }); } }
  const backend = new B('trunc', ['a', 'b', 'c']); const result = await new PresentationSemanticController(backend).execute(reorder(backend, 0, 'c'), completeBounds); assert.equal(result.status, 'verification-failed'); assert.equal(backend.dispatchCount, 1);
});

test('backend result metadata cannot substitute for model verification', async () => {
  class B extends DeterministicPresentationBackend { override async dispatchSemanticEdit(i: Parameters<DeterministicPresentationBackend['dispatchSemanticEdit']>[0]): Promise<PresentationDispatchResult> { const r = await super.dispatchSemanticEdit(i); r.revision = -99; return r; } }
  const backend = new B('result', ['a', 'b', 'c']); assert.equal((await new PresentationSemanticController(backend).execute(reorder(backend, 0, 'c'), completeBounds)).status, 'verified');
});

test('backend that mutates then throws is uncertain and not replayed', async () => {
  class B extends DeterministicPresentationBackend { override async dispatchSemanticEdit(i: Parameters<DeterministicPresentationBackend['dispatchSemanticEdit']>[0]): Promise<PresentationDispatchResult> { await super.dispatchSemanticEdit(i); throw new Error('lost after dispatch'); } }
  const backend = new B('throw', ['a', 'b', 'c']); const result = await new PresentationSemanticController(backend).execute(reorder(backend, 0, 'c'), completeBounds); assert.equal(result.status, 'uncertain'); assert.equal(result.dispatch, 'uncertain'); assert.deepEqual(backend.objectIds(), ['b', 'a', 'c']); assert.equal(backend.dispatchCount, 1); if (result.status === 'uncertain') assert.equal(result.verification.status, 'verified');
});

test('explicit uncertain dispatch is never replayed', async () => {
  const backend = new DeterministicPresentationBackend('uncertain', ['a', 'b', 'c']); backend.markNextDispatchUncertain(); const result = await new PresentationSemanticController(backend).execute(reorder(backend, 0, 'c'), completeBounds); assert.equal(result.status, 'uncertain'); assert.equal(backend.dispatchCount, 1);
});
