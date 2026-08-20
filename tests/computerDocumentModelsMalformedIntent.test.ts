// @ts-ignore
import assert from 'node:assert/strict';
// @ts-ignore
import test from 'node:test';
import { classifyIntentEffect, validateIntent, type DocumentRef, type SemanticEditIntent } from '../src/computer/documentModels.js';

const document: DocumentRef = { documentId: 'doc', generation: 1, kind: 'word-processing' };
const base = { intentId: 'i', document };

const malformed: readonly unknown[] = [
  { ...base, kind: 'insert-text', effect: 'local-reversible-edit', at: 0, text: 'x' },
  { ...base, kind: 'replace-text', effect: 'local-reversible-edit', target: {}, range: 'bad', text: 'x' },
  { ...base, kind: 'apply-text-formatting', effect: 'local-reversible-edit', target: {}, range: { start: 0, end: 1 }, formatting: null },
  { ...base, kind: 'set-cell-value', effect: 'local-reversible-edit', target: {}, value: {} },
  { ...base, kind: 'set-cell-formula', effect: 'local-reversible-edit', target: {}, formula: 42 },
  { ...base, kind: 'add-structured-object', effect: 'local-reversible-edit', container: {}, objectKind: 7, properties: [] },
  { ...base, kind: 'remove-structured-object', effect: 'local-destructive-edit' },
  { ...base, kind: 'reorder-structured-object', effect: 'local-reversible-edit', target: {}, beforeEntityId: 4 },
  { ...base, kind: 'edit-code-buffer', effect: 'local-reversible-edit', target: {}, range: { start: {}, end: {} }, text: 9 },
  { ...base, kind: 'save-document', effect: 'local-persistence', document: { documentId: 1, generation: 'bad', kind: null } },
  { ...base, kind: 'export-document', effect: 'local-persistence', format: 4, destination: { kind: 'unknown' } },
  { ...base, kind: 'publish-document', effect: 'external-publication' },
];

test('runtime intent validation reports malformed per-kind shapes without throwing', () => {
  for (const value of malformed) {
    let errors: readonly string[] = [];
    assert.doesNotThrow(() => { errors = validateIntent(value); });
    assert.ok(errors.length > 0, JSON.stringify(value));
  }
});

test('wrong-typed top-level runtime intent fields fail closed', () => {
  assert.deepEqual(validateIntent(null), ['intent must be an object']);
  assert.ok(validateIntent({ kind: 'publish-document', effect: 'external-publication', document, intentId: 3, destinationId: 'x' }).length > 0);
  assert.ok(validateIntent({ kind: 'unknown', effect: 'local-reversible-edit', document, intentId: 'x' }).includes('intent kind is unsupported'));
});

test('classification cannot turn malformed shapes into policy decisions', () => {
  const malformedPublish = { ...base, kind: 'publish-document', effect: 'external-publication' } as unknown as SemanticEditIntent;
  assert.throws(() => classifyIntentEffect(malformedPublish), /destinationId must be a bounded opaque identifier/);
});
