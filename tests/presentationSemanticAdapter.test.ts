// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import type { AddStructuredObjectIntent, RemoveStructuredObjectIntent, ReorderStructuredObjectIntent } from '../src/computer/documentModels.js';
import {
  DeterministicPresentationBackend,
  PresentationSemanticController,
  type PlannedPresentationAdd,
  type PresentationDispatchResult,
} from '../src/application/presentationSemanticAdapter.js';

const completeBounds = { maxItems: 16, maxTextBytes: 1024 };
function reorder(backend: DeterministicPresentationBackend, targetIndex = 0, beforeEntityId?: string): ReorderStructuredObjectIntent {
  return { kind: 'reorder-structured-object', intentId: 'reorder', document: backend.currentDocument(), effect: 'local-reversible-edit', target: backend.objectRef(targetIndex), ...(beforeEntityId === undefined ? {} : { beforeEntityId }) };
}
function remove(backend: DeterministicPresentationBackend, targetIndex = 0): RemoveStructuredObjectIntent {
  return { kind: 'remove-structured-object', intentId: 'remove', document: backend.currentDocument(), effect: 'local-reversible-edit', target: backend.objectRef(targetIndex) };
}
function add(backend: DeterministicPresentationBackend, beforeEntityId?: string): AddStructuredObjectIntent {
  return {
    kind: 'add-structured-object',
    intentId: 'add',
    document: backend.currentDocument(),
    effect: 'local-reversible-edit',
    container: backend.slideRef(),
    objectKind: 'text-box',
    ...(beforeEntityId === undefined ? {} : { beforeEntityId }),
    properties: { label: 'planned' },
  };
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

test('planned native add dispatches once and verifies resulting order plus entity identity', async () => {
  const backend = new DeterministicPresentationBackend('add-end', ['a', 'b']);
  const before = await backend.readRevision();
  const result = await new PresentationSemanticController(backend).execute(add(backend), completeBounds);
  assert.equal(result.status, 'verified'); assert.equal(result.dispatch, 'dispatched'); assert.deepEqual(backend.objectIds(), ['a', 'b', 'added-object-1']); assert.equal(backend.dispatchCount, 1); assert.equal(await backend.readRevision(), before + 1);
  const identity = await backend.readIdentity(); const added = identity.entities.find(entity => entity.entityId === 'added-object-1'); assert.deepEqual(added, { kind: 'presentation-object', entityId: 'added-object-1', generation: 1 });
});

test('planned add can insert before an existing object', async () => {
  const backend = new DeterministicPresentationBackend('add-before', ['a', 'b', 'c']);
  const result = await new PresentationSemanticController(backend).execute(add(backend, 'b'), completeBounds);
  assert.equal(result.status, 'verified'); assert.deepEqual(backend.objectIds(), ['a', 'added-object-1', 'b', 'c']); assert.equal(backend.dispatchCount, 1);
});

test('missing add anchor is rejected before dispatch', async () => {
  const backend = new DeterministicPresentationBackend('add-missing', ['a', 'b']); const before = backend.objectIds();
  const result = await new PresentationSemanticController(backend).execute(add(backend, 'missing'), completeBounds);
  assert.equal(result.status, 'rejected'); assert.deepEqual(backend.objectIds(), before); assert.equal(backend.dispatchCount, 0);
});

test('stale add plan revision is rejected without dispatch', async () => {
  class B extends DeterministicPresentationBackend {
    override async planAddObject(intent: AddStructuredObjectIntent): Promise<PlannedPresentationAdd> {
      const plan = await super.planAddObject(intent); return { ...plan, revision: plan.revision + 1 };
    }
  }
  const backend = new B('add-stale-plan', ['a']); const result = await new PresentationSemanticController(backend).execute(add(backend), completeBounds);
  assert.equal(result.status, 'rejected'); assert.equal(backend.dispatchCount, 0); if (result.status === 'rejected') assert.match(result.reason, /revision/);
});

test('add verification fails when resulting identity omits the planned object despite matching order', async () => {
  class B extends DeterministicPresentationBackend {
    override async readIdentity(): ReturnType<DeterministicPresentationBackend['readIdentity']> {
      const identity = await super.readIdentity();
      if (this.dispatchCount === 0) return identity;
      return { ...identity, entities: identity.entities.filter(entity => !entity.entityId.startsWith('added-object-')) };
    }
  }
  const backend = new B('add-identity-mismatch', ['a']); const result = await new PresentationSemanticController(backend).execute(add(backend), completeBounds);
  assert.equal(result.status, 'verification-failed'); assert.equal(backend.dispatchCount, 1); if (result.status === 'verification-failed') assert.deepEqual(result.verification.evidence, ['planned-presentation-object-identity-mismatch']);
});

test('caller add intent is snapshotted before awaits', async () => {
  const backend = new DeterministicPresentationBackend('add-snapshot', ['a', 'b']); const intent = add(backend, 'b'); const promise = new PresentationSemanticController(backend).execute(intent, completeBounds); intent.container.generation = 99; intent.beforeEntityId = 'a'; if (intent.properties) (intent.properties as Record<string, string | number | boolean | null>).label = 'mutated'; const result = await promise; assert.equal(result.status, 'verified'); assert.deepEqual(backend.objectIds(), ['a', 'added-object-1', 'b']);
});

test('caller reorder intent is snapshotted before awaits', async () => {
  const backend = new DeterministicPresentationBackend('snap', ['a', 'b', 'c']); const intent = reorder(backend, 0, 'c'); const promise = new PresentationSemanticController(backend).execute(intent, completeBounds); intent.target.generation = 99; intent.beforeEntityId = 'b'; assert.equal((await promise).status, 'verified'); assert.deepEqual(backend.objectIds(), ['b', 'a', 'c']);
});

test('truncated post-edit observation cannot prove success', async () => {
  class B extends DeterministicPresentationBackend { private calls = 0; override async observeObjectOrder(c: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[0], b: Parameters<DeterministicPresentationBackend['observeObjectOrder']>[1]): ReturnType<DeterministicPresentationBackend['observeObjectOrder']> { this.calls += 1; return super.observeObjectOrder(c, this.calls === 1 ? b : { maxItems: 1, maxTextBytes: b.maxTextBytes }); } }
  const backend = new B('trunc', ['a', 'b', 'c']); const result = await new PresentationSemanticController(backend).execute(reorder(backend, 0, 'c'), completeBounds); assert.equal(result.status, 'verification-failed'); assert.equal(backend.dispatchCount, 1);
});

test('backend result metadata cannot substitute for model verification', async () => {
  class B extends DeterministicPresentationBackend { override async dispatchSemanticEdit(i: Parameters<DeterministicPresentationBackend['dispatchSemanticEdit']>[0], p?: PlannedPresentationAdd): Promise<PresentationDispatchResult> { const r = await super.dispatchSemanticEdit(i, p); r.revision = -99; return r; } }
  const backend = new B('result', ['a', 'b', 'c']); assert.equal((await new PresentationSemanticController(backend).execute(reorder(backend, 0, 'c'), completeBounds)).status, 'verified');
});

test('add backend that mutates then throws is uncertain and not replayed', async () => {
  class B extends DeterministicPresentationBackend { override async dispatchSemanticEdit(i: Parameters<DeterministicPresentationBackend['dispatchSemanticEdit']>[0], p?: PlannedPresentationAdd): Promise<PresentationDispatchResult> { await super.dispatchSemanticEdit(i, p); throw new Error('lost after add dispatch'); } }
  const backend = new B('add-throw', ['a']); const result = await new PresentationSemanticController(backend).execute(add(backend), completeBounds); assert.equal(result.status, 'uncertain'); assert.equal(result.dispatch, 'uncertain'); assert.deepEqual(backend.objectIds(), ['a', 'added-object-1']); assert.equal(backend.dispatchCount, 1); if (result.status === 'uncertain') assert.equal(result.verification.status, 'verified');
});

test('backend that reorders then throws is uncertain and not replayed', async () => {
  class B extends DeterministicPresentationBackend { override async dispatchSemanticEdit(i: Parameters<DeterministicPresentationBackend['dispatchSemanticEdit']>[0], p?: PlannedPresentationAdd): Promise<PresentationDispatchResult> { await super.dispatchSemanticEdit(i, p); throw new Error('lost after dispatch'); } }
  const backend = new B('throw', ['a', 'b', 'c']); const result = await new PresentationSemanticController(backend).execute(reorder(backend, 0, 'c'), completeBounds); assert.equal(result.status, 'uncertain'); assert.equal(result.dispatch, 'uncertain'); assert.deepEqual(backend.objectIds(), ['b', 'a', 'c']); assert.equal(backend.dispatchCount, 1); if (result.status === 'uncertain') assert.equal(result.verification.status, 'verified');
});

test('explicit uncertain add dispatch is never replayed', async () => {
  const backend = new DeterministicPresentationBackend('add-uncertain', ['a']); backend.markNextDispatchUncertain(); const result = await new PresentationSemanticController(backend).execute(add(backend), completeBounds); assert.equal(result.status, 'uncertain'); assert.equal(backend.dispatchCount, 1);
});
