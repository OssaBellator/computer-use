import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createIsolatedLocalComputeAdapter,
  defineIsolatedLocalComputeOperation,
} from '../src/computer/isolatedLocalComputeOperation.js';
import type { LocalComputeJson } from '../src/computer/localComputeAdapter.js';

const moduleUrl = new URL('./fixtures/isolatedLocalComputeOperations.js', import.meta.url).href;

test('preferred isolated adapter construction rejects non-file operation modules before creation', () => {
  assert.throws(
    () => createIsolatedLocalComputeAdapter({
      id: 'factory-test',
      operations: [{ id: 'bad.module', effect: 'pure-read-only', moduleUrl: 'node:child_process', exportName: 'exec' }],
    }),
    /must use file: URL/,
  );
});

test('preferred isolated adapter construction accepts and snapshots file-backed registrations', () => {
  const definition = { id: 'test.echo', effect: 'pure-read-only' as const, moduleUrl, exportName: 'echo' };
  const adapter = createIsolatedLocalComputeAdapter({ id: 'factory-test', operations: [definition] });
  definition.moduleUrl = 'node:child_process';
  definition.exportName = 'exec';
  assert.equal(adapter.descriptor.id, 'factory-test');
});

test('isolated operation type helper preserves the registered callback', async () => {
  const operation = defineIsolatedLocalComputeOperation((input: LocalComputeJson, context) => {
    context.diagnostic('test.operation-called');
    return input;
  });
  const diagnostics: string[] = [];
  const result = await operation({ ok: true }, {
    operationId: 'test.echo',
    deadlineEpochMs: Date.now() + 1_000,
    limits: {
      maxOutputBytes: 1024,
      maxDiagnosticBytes: 1024,
      maxJsonDepth: 16,
      maxJsonItems: 100,
      memoryBytesHint: 1024 * 1024,
    },
    diagnostic: (code) => diagnostics.push(code),
  });
  assert.deepEqual(result, { ok: true });
  assert.deepEqual(diagnostics, ['test.operation-called']);
});
