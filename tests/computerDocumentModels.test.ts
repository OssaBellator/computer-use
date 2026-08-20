// @ts-ignore -- repository devDependencies provide @types/node; local synthetic validation may not.
import assert from 'node:assert/strict';
// @ts-ignore -- repository devDependencies provide @types/node; local synthetic validation may not.
import test from 'node:test';

import {
  checkDocumentFreshness,
  checkEntityFreshness,
  classifyIntentEffect,
  describeReplacement,
  observeBoundedItems,
  observeTextRange,
  validateIntent,
  verifyPostEdit,
  type CodeBufferRef,
  type DocumentIdentityState,
  type DocumentRef,
  type SemanticEditIntent,
  type StructuredEntityRef,
} from '../src/computer/documentModels.js';

const document: DocumentRef = {
  documentId: 'doc-1',
  generation: 3,
  kind: 'word-processing',
};

const section: StructuredEntityRef = {
  document,
  kind: 'section',
  entityId: 'section-1',
  generation: 2,
};

const identity: DocumentIdentityState = {
  document,
  entities: [
    { kind: 'section', entityId: 'section-1', generation: 2 },
    { kind: 'table', entityId: 'table-1', generation: 1 },
  ],
};

test('document identity is opaque and generation-sensitive', () => {
  assert.deepEqual(checkDocumentFreshness(document, { ...document }), { fresh: true });
  assert.deepEqual(
    checkDocumentFreshness(document, { ...document, documentId: 'doc-2' }),
    { fresh: false, reason: 'document-identity-mismatch' },
  );
  assert.deepEqual(
    checkDocumentFreshness(document, { ...document, generation: 4 }),
    { fresh: false, reason: 'document-generation-stale' },
  );
});

test('reload/reopen/replacement explicitly advance document generation', () => {
  const replacement = describeReplacement(document, { ...document, generation: 4 }, 'reopen');
  assert.equal(replacement.reason, 'reopen');
  assert.equal(replacement.previous.generation, 3);
  assert.equal(replacement.current.generation, 4);
  assert.throws(
    () => describeReplacement(document, { ...document, generation: 3 }, 'reload'),
    /advance document generation/,
  );
});

test('stale sheet/slide/buffer/object references fail closed', () => {
  assert.deepEqual(checkEntityFreshness(section, identity), { fresh: true });
  assert.deepEqual(
    checkEntityFreshness({ ...section, generation: 1 }, identity),
    { fresh: false, reason: 'entity-generation-stale' },
  );
  assert.deepEqual(
    checkEntityFreshness({ ...section, entityId: 'missing' }, identity),
    { fresh: false, reason: 'entity-missing' },
  );
  assert.deepEqual(
    checkEntityFreshness({ ...section, document: { ...document, generation: 2 } }, identity),
    { fresh: false, reason: 'document-generation-stale' },
  );
});

test('text observation is targeted, byte-bounded, deterministic, and explicitly truncated', () => {
  const source = 'prefix αβγ suffix';
  const range = { start: 7, end: 10 };
  const observation = observeTextRange(source, range, { maxItems: 10, maxTextBytes: 4 });
  assert.equal(observation.text, 'αβ');
  assert.equal(observation.totalUtf8Bytes, 6);
  assert.equal(observation.exposedUtf8Bytes, 4);
  assert.equal(observation.truncated, true);
  assert.equal(observation.omittedUtf8Bytes, 2);
  assert.deepEqual(observation.range, range);
});

test('metadata-only text observation protects content while retaining bounded metadata', () => {
  const observation = observeTextRange(
    'secret customer text',
    { start: 0, end: 20 },
    { maxItems: 10, maxTextBytes: 128 },
    'metadata-only',
  );
  assert.equal(observation.exposure, 'metadata-only');
  assert.equal('text' in observation, false);
  assert.equal(observation.exposedUtf8Bytes, 0);
  assert.equal(observation.omittedUtf8Bytes, observation.totalUtf8Bytes);
  assert.equal(observation.truncated, true);
});

test('structured object observation is item-bounded with omission counts', () => {
  const observed = observeBoundedItems(
    ['slide-1', 'slide-2', 'slide-3', 'slide-4'],
    { maxItems: 2, maxTextBytes: 64 },
  );
  assert.deepEqual(observed.items, ['slide-1', 'slide-2']);
  assert.equal(observed.totalItems, 4);
  assert.equal(observed.truncated, true);
  assert.equal(observed.omittedItems, 2);
});

test('spreadsheet formulas remain distinct from displayed values during verification', () => {
  const spreadsheet: DocumentRef = { documentId: 'book-1', generation: 1, kind: 'spreadsheet' };
  const sheet: StructuredEntityRef = {
    document: spreadsheet,
    kind: 'sheet',
    entityId: 'sheet-1',
    generation: 5,
  };
  const result = verifyPostEdit({
    identity: {
      document: spreadsheet,
      entities: [{ kind: 'sheet', entityId: 'sheet-1', generation: 5 }],
    },
    beforeRevision: 10,
    expectation: {
      kind: 'cell-input-equals',
      target: sheet,
      address: { row: 0, column: 1 },
      expected: { kind: 'formula', formula: '=A1*2' },
    },
    observation: {
      kind: 'cells',
      target: sheet,
      revision: 11,
      truncated: false,
      cells: [{
        address: { row: 0, column: 1 },
        input: { kind: 'formula', formula: '=A1*2' },
        displayedValue: '42',
      }],
    },
  });
  assert.deepEqual(result, { status: 'verified', evidence: ['cell-input-model-matches'] });
});

test('edit intents represent semantic operations without UI mechanism fields', () => {
  const intent: SemanticEditIntent = {
    kind: 'replace-text',
    intentId: 'intent-1',
    document,
    effect: 'local-reversible-edit',
    target: section,
    range: { start: 4, end: 9 },
    text: 'model',
  };
  assert.deepEqual(validateIntent(intent), []);
  assert.equal(classifyIntentEffect(intent), 'local-reversible-edit');
  assert.equal('key' in intent, false);
  assert.equal('click' in intent, false);
  assert.equal('selector' in intent, false);
});

test('code-buffer edits bind range and target to the same fresh buffer identity', () => {
  const workspace: DocumentRef = { documentId: 'workspace-1', generation: 2, kind: 'code-workspace' };
  const buffer: CodeBufferRef = {
    document: workspace,
    kind: 'code-buffer',
    entityId: 'buffer-1',
    generation: 7,
    languageId: 'typescript',
  };
  const intent: SemanticEditIntent = {
    kind: 'edit-code-buffer',
    intentId: 'code-edit-1',
    document: workspace,
    effect: 'local-reversible-edit',
    target: buffer,
    range: {
      buffer,
      start: { line: 3, column: 2 },
      end: { line: 3, column: 8 },
    },
    text: 'renamed',
  };
  assert.deepEqual(validateIntent(intent), []);

  const staleBuffer = { ...buffer, generation: 6 };
  assert.ok(validateIntent({ ...intent, range: { ...intent.range, buffer: staleBuffer } }).includes(
    'code range buffer does not match edit target',
  ));
});

test('post-edit verification requires changed application/model state, not dispatch success', () => {
  const unchanged = verifyPostEdit({
    identity,
    beforeRevision: 20,
    expectation: {
      kind: 'text-equals',
      target: section,
      range: { start: 0, end: 5 },
      expected: 'hello',
    },
    observation: {
      kind: 'text',
      target: section,
      revision: 20,
      observation: observeTextRange('hello', { start: 0, end: 5 }, { maxItems: 1, maxTextBytes: 16 }),
    },
  });
  assert.deepEqual(unchanged, { status: 'mismatch', evidence: ['model-revision-did-not-advance'] });

  const changed = verifyPostEdit({
    identity,
    beforeRevision: 20,
    expectation: {
      kind: 'text-equals',
      target: section,
      range: { start: 0, end: 5 },
      expected: 'hello',
    },
    observation: {
      kind: 'text',
      target: section,
      revision: 21,
      observation: observeTextRange('hello', { start: 0, end: 5 }, { maxItems: 1, maxTextBytes: 16 }),
    },
  });
  assert.deepEqual(changed, { status: 'verified', evidence: ['text-model-matches'] });
});

test('post-edit verification fails closed for stale target generations', () => {
  const staleSection = { ...section, generation: 1 };
  const result = verifyPostEdit({
    identity,
    beforeRevision: 1,
    expectation: {
      kind: 'text-equals',
      target: staleSection,
      range: { start: 0, end: 1 },
      expected: 'x',
    },
    observation: {
      kind: 'text',
      target: staleSection,
      revision: 2,
      observation: observeTextRange('x', { start: 0, end: 1 }, { maxItems: 1, maxTextBytes: 8 }),
    },
  });
  assert.deepEqual(result, {
    status: 'stale-target',
    reason: 'entity-generation-stale',
    evidence: ['semantic-target-stale'],
  });
});

test('truncated verification observations cannot prove success', () => {
  const result = verifyPostEdit({
    identity,
    beforeRevision: 5,
    expectation: {
      kind: 'text-equals',
      target: section,
      range: { start: 0, end: 6 },
      expected: 'abcdef',
    },
    observation: {
      kind: 'text',
      target: section,
      revision: 6,
      observation: observeTextRange('abcdef', { start: 0, end: 6 }, { maxItems: 1, maxTextBytes: 3 }),
    },
  });
  assert.deepEqual(result, {
    status: 'insufficient-observation',
    evidence: ['text-observation-not-complete'],
  });
});

test('local save, destructive edit, and external publication are distinct effects', () => {
  const save: SemanticEditIntent = {
    kind: 'save-document',
    intentId: 'save-1',
    document,
    effect: 'local-persistence',
  };
  const destructive: SemanticEditIntent = {
    kind: 'remove-structured-object',
    intentId: 'remove-1',
    document,
    target: section,
    effect: 'local-destructive-edit',
  };
  const publish: SemanticEditIntent = {
    kind: 'publish-document',
    intentId: 'publish-1',
    document,
    effect: 'external-publication',
    destinationId: 'remote-destination',
  };
  assert.equal(classifyIntentEffect(save), 'local-persistence');
  assert.equal(classifyIntentEffect(destructive), 'local-destructive-edit');
  assert.equal(classifyIntentEffect(publish), 'external-publication');
});

test('local and external exports cannot be misclassified', () => {
  const localExport: SemanticEditIntent = {
    kind: 'export-document',
    intentId: 'export-local',
    document,
    effect: 'local-persistence',
    format: 'pdf',
    destination: { kind: 'local-artifact', artifactId: 'artifact-1' },
  };
  const externalExport: SemanticEditIntent = {
    kind: 'export-document',
    intentId: 'export-external',
    document,
    effect: 'external-publication',
    format: 'pdf',
    destination: { kind: 'external-target', targetId: 'target-1' },
  };
  assert.deepEqual(validateIntent(localExport), []);
  assert.deepEqual(validateIntent(externalExport), []);
  assert.ok(validateIntent({ ...localExport, effect: 'external-publication' }).includes(
    'local export must be classified as local-persistence',
  ));
  assert.ok(validateIntent({ ...externalExport, effect: 'local-persistence' }).includes(
    'external export must be classified as external-publication',
  ));
});

test('structured-object reorder verification requires a complete deterministic order', () => {
  const container: StructuredEntityRef = {
    document,
    kind: 'section',
    entityId: 'section-1',
    generation: 2,
  };
  const complete = verifyPostEdit({
    identity,
    beforeRevision: 30,
    expectation: {
      kind: 'entity-order-equals',
      target: container,
      expectedEntityIds: ['a', 'c', 'b'],
    },
    observation: {
      kind: 'entity-order',
      target: container,
      revision: 31,
      entityIds: ['a', 'c', 'b'],
      truncated: false,
    },
  });
  assert.deepEqual(complete, { status: 'verified', evidence: ['entity-order-model-matches'] });

  const truncated = verifyPostEdit({
    identity,
    beforeRevision: 30,
    expectation: {
      kind: 'entity-order-equals',
      target: container,
      expectedEntityIds: ['a', 'c', 'b'],
    },
    observation: {
      kind: 'entity-order',
      target: container,
      revision: 31,
      entityIds: ['a', 'c'],
      truncated: true,
    },
  });
  assert.deepEqual(truncated, {
    status: 'insufficient-observation',
    evidence: ['entity-order-observation-truncated'],
  });
});
