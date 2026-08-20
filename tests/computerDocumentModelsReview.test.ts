// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import { classifyIntentEffect, observeBoundedItems, validateIntent, verifyPostEdit, observeTextRange, type DocumentIdentityState, type DocumentRef, type StructuredEntityRef } from '../src/computer/documentModels.js';

const document: DocumentRef = { documentId: 'doc', generation: 1, kind: 'word-processing' };
const section: StructuredEntityRef = { document, kind: 'section', entityId: 'section', generation: 1 };
const identity: DocumentIdentityState = { document, entities: [{ kind: 'section', entityId: 'section', generation: 1 }] };

test('runtime intent kind and effect validation blocks forged policy classification', () => {
  const forged = { kind: 'publish-document', intentId: 'p', document, effect: 'local-reversible-edit', destinationId: 'remote' } as any;
  assert.ok(validateIntent(forged).includes('effect is not allowed for publish-document'));
  assert.throws(() => classifyIntentEffect(forged), /invalid semantic intent/);
  const unknown = { kind: 'future-magic', intentId: 'x', document, effect: 'local-reversible-edit' } as any;
  assert.deepEqual(validateIntent(unknown), ['intent kind is unsupported']);
});

test('verification fails closed on invalid revision values', () => {
  const observation = { kind: 'text' as const, target: section, revision: NaN, observation: observeTextRange('x', { start: 0, end: 1 }, { maxItems: 1, maxTextBytes: 8 }) };
  assert.deepEqual(verifyPostEdit({ identity, beforeRevision: 0, expectation: { kind: 'text-equals', target: section, range: { start: 0, end: 1 }, expected: 'x' }, observation }), { status: 'insufficient-observation', evidence: ['invalid-model-revision'] });
  assert.deepEqual(verifyPostEdit({ identity, beforeRevision: 0, expectation: { kind: 'saved-revision-at-least', target: document, minimumRevision: NaN }, observation: { kind: 'saved-state', target: document, revision: 1, savedRevision: 1 } }), { status: 'insufficient-observation', evidence: ['invalid-saved-revision'] });
  assert.deepEqual(verifyPostEdit({ identity, beforeRevision: 0, expectation: { kind: 'saved-revision-at-least', target: document, minimumRevision: 1 }, observation: { kind: 'saved-state', target: document, revision: 1, savedRevision: Infinity } }), { status: 'insufficient-observation', evidence: ['invalid-saved-revision'] });
});

test('structured item observation retains only bounded projected strings', () => {
  const source = [{ label: 'one', secret: 'x'.repeat(100_000) }, { label: 'two', secret: 'y'.repeat(100_000) }];
  assert.throws(() => observeBoundedItems(source, { maxItems: 2, maxTextBytes: 8 }), /explicit bounded string projection/);
  const observed = observeBoundedItems(source, { maxItems: 2, maxTextBytes: 6 }, item => item.label);
  assert.deepEqual(observed.items, ['one', 'two']);
  assert.equal(observed.exposedTextBytes, 6);
  assert.equal(typeof observed.items[0], 'string');
});
