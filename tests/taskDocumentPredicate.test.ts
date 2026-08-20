import test from 'node:test';
import assert from 'node:assert/strict';
import type { DocumentContentSnapshot } from '../src/browser/documentContent.js';
import {
  analyzeTaskProgramCapabilities,
} from '../src/capabilities/webTaskCapabilities.js';
import {
  validateTaskProgram,
  type TaskProgram,
} from '../src/agent/taskProgram.js';
import {
  evaluateTaskPredicate,
  observeTaskEngine,
} from '../src/agent/taskObservation.js';
import { TaskRuntime } from '../src/agent/taskRuntime.js';
import type { TaskRuntimeEngine } from '../src/agent/taskRuntimeContracts.js';

function documentSnapshot(texts: readonly string[]): DocumentContentSnapshot {
  return {
    frames: [{
      frameId: 'main',
      title: 'Fixture',
      includedBlocks: texts.length,
      browserExtractionTruncated: false,
    }],
    blocks: texts.map((text, index) => ({
      id: `main:p:${index}`,
      frameId: 'main',
      kind: index === 0 ? 'heading' : 'paragraph',
      tagName: index === 0 ? 'h1' : 'p',
      depth: 2,
      text,
      ...(index === 1 ? { href: 'https://example.test/source' } : {}),
      rendered: true,
      inViewport: index < 2,
      truncated: false,
    })),
    totalTextBytes: texts.reduce((sum, text) => sum + Buffer.byteLength(text), 0),
    truncated: false,
    frameErrors: [],
  };
}

function engineWithDocument(snapshot: DocumentContentSnapshot) {
  let documentCalls = 0;
  const engine: TaskRuntimeEngine = {
    async refresh() { return []; },
    async documentContent() { documentCalls += 1; return snapshot; },
    async activate() { return { status: 'target-not-found', target: null }; },
    async typeInto() { return { status: 'target-not-found', target: null }; },
  };
  return { engine, documentCalls: () => documentCalls };
}

test('document predicates match structural fields, program inputs, and minimum counts', () => {
  const document = documentSnapshot(['Research Result', 'source alpha', 'source beta']);
  const nodes: never[] = [];

  assert.equal(evaluateTaskPredicate({
    kind: 'document',
    state: { kind: 'heading', textIncludes: { input: 'query' }, inViewport: true },
  }, nodes, { query: 'Research' }, undefined, undefined, undefined, undefined, document), true);

  assert.equal(evaluateTaskPredicate({
    kind: 'document',
    state: { kind: 'paragraph', textIncludes: 'source', rendered: true, minMatches: 2 },
  }, nodes, {}, undefined, undefined, undefined, undefined, document), true);

  assert.equal(evaluateTaskPredicate({
    kind: 'document',
    state: { hrefIncludes: '/source', frameId: 'main' },
  }, nodes, {}, undefined, undefined, undefined, undefined, document), true);

  assert.equal(evaluateTaskPredicate({
    kind: 'document',
    state: { kind: 'paragraph', inViewport: true, minMatches: 2 },
  }, nodes, {}, undefined, undefined, undefined, undefined, document), false);
});

test('task program validation checks document inputs and minMatches', () => {
  const bad: TaskProgram = {
    version: 1,
    entry: 'assert',
    steps: [
      {
        id: 'assert', kind: 'assert',
        condition: {
          kind: 'document',
          state: { textIncludes: { input: 'missing' }, minMatches: 0 },
        },
        next: 'complete',
      },
      { id: 'complete', kind: 'complete' },
    ],
  };
  const validation = validateTaskProgram(bad);
  assert.equal(validation.valid, false);
  assert.equal(validation.errors.some((error) => /document minMatches/.test(error)), true);
  assert.equal(validation.errors.some((error) => /undeclared input: missing/.test(error)), true);
});

test('document observations are opt-in and contribute to observation fingerprints', async () => {
  const fixture = engineWithDocument(documentSnapshot(['one']));
  const ordinary = await observeTaskEngine(fixture.engine);
  assert.equal(fixture.documentCalls(), 0);
  assert.equal(ordinary.document, undefined);

  const withDocument = await observeTaskEngine(fixture.engine, { document: true });
  assert.equal(fixture.documentCalls(), 1);
  assert.equal(withDocument.document?.blocks[0].text, 'one');
  assert.notEqual(withDocument.fingerprint, ordinary.fingerprint);
});

test('TaskRuntime only reads document content for programs that use document predicates', async () => {
  const ordinaryFixture = engineWithDocument(documentSnapshot(['Ready']));
  const ordinaryProgram: TaskProgram = {
    version: 1,
    entry: 'complete',
    steps: [{ id: 'complete', kind: 'complete' }],
  };
  const ordinary = await new TaskRuntime(ordinaryFixture.engine).run(ordinaryProgram);
  assert.equal(ordinary.status, 'completed');
  assert.equal(ordinaryFixture.documentCalls(), 0);

  const documentFixture = engineWithDocument(documentSnapshot(['Ready']));
  const documentProgram: TaskProgram = {
    version: 1,
    entry: 'complete',
    steps: [{
      id: 'complete',
      kind: 'complete',
      condition: { kind: 'document', state: { kind: 'heading', text: 'Ready' } },
    }],
  };
  const documentResult = await new TaskRuntime(documentFixture.engine).run(documentProgram);
  assert.equal(documentResult.status, 'completed');
  assert.ok(documentFixture.documentCalls() >= 1);
});

test('TaskProgram capability analysis includes document-content observation', () => {
  const program: TaskProgram = {
    version: 1,
    entry: 'complete',
    steps: [{
      id: 'complete',
      kind: 'complete',
      condition: { kind: 'document', state: { textIncludes: 'result' } },
    }],
  };
  const analysis = analyzeTaskProgramCapabilities(program);
  assert.deepEqual(analysis.required, [
    'task-program-execution',
    'document-content-observation',
  ]);
});
