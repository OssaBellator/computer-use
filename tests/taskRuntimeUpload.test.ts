import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime, type TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import { validateTaskProgram, type TaskProgram } from '../src/agent/taskProgram.js';
import type { InteractionNode } from '../src/types.js';

function fileNode(value = ''): InteractionNode {
  return {
    id: 'file',
    frameId: 'main',
    backendNodeId: 7,
    role: 'input',
    name: 'Upload',
    value,
    focused: false,
    disabled: false,
    focusable: true,
    clickable: false,
    editable: false,
    scrollable: false,
    capabilities: ['upload'],
    interactionConfidence: 1,
  };
}

function program(): TaskProgram {
  return {
    version: 1,
    entry: 'upload',
    inputs: ['filePath'],
    steps: [
      {
        id: 'upload',
        kind: 'upload',
        target: { name: 'Upload', capability: 'upload' },
        files: [{ input: 'filePath' }],
        next: 'done',
        onFailure: 'failed',
      },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };
}

test('upload task is always external-side-effect and is blocked by the default risk budget', async () => {
  let calls = 0;
  const engine: TaskRuntimeEngine = {
    async refresh() { return [fileNode()]; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
    async uploadFiles() {
      calls += 1;
      return { status: 'uploaded', targetId: 'file', fileCount: 1, totalBytes: 3 };
    },
  };

  const localPath = '/trusted/private/file.txt';
  const result = await new TaskRuntime(engine).run(program(), { filePath: localPath });

  assert.equal(result.status, 'policy-blocked');
  assert.equal(calls, 0);
  assert.equal(result.trace[0]?.outcome, 'policy-blocked');
  assert.equal(JSON.stringify(result.trace).includes(localPath), false);
});

test('explicit approval permits trusted-input upload without putting the path in traces', async () => {
  let current = fileNode();
  let approvedRisk: string | undefined;
  let uploadedPath: string | undefined;
  const engine: TaskRuntimeEngine = {
    async refresh() { return [current]; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
    async uploadFiles(_query, paths, options) {
      assert.equal(options?.requireUnambiguous, true);
      uploadedPath = paths[0];
      current = fileNode('selected');
      return { status: 'uploaded', targetId: 'file', fileCount: 1, totalBytes: 3 };
    },
  };
  const localPath = '/trusted/private/file.txt';

  const result = await new TaskRuntime(engine).run(
    program(),
    { filePath: localPath },
    {
      approve: async (context) => {
        approvedRisk = context.risk;
        assert.equal(context.kind, 'upload');
        return true;
      },
    },
  );

  assert.equal(result.status, 'completed');
  assert.equal(approvedRisk, 'external-side-effect');
  assert.equal(uploadedPath, localPath);
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['uploaded', 'completed']);
  assert.equal(result.trace[0]?.targetId, 'file');
  assert.equal(JSON.stringify(result.trace).includes(localPath), false);
});

test('upload task fails closed when no upload engine is available', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return [fileNode()]; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };

  const result = await new TaskRuntime(engine).run(
    program(),
    { filePath: '/trusted/file.txt' },
    { maxRisk: 'external-side-effect', maxConsecutiveNoProgress: 10 },
  );

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['failed', 'failed']);
});

test('upload program validation requires files and declared trusted inputs', () => {
  const invalid = {
    version: 1,
    entry: 'upload',
    inputs: [],
    steps: [
      {
        id: 'upload', kind: 'upload', target: { capability: 'upload' },
        files: [{ input: 'secretPath' }], next: 'done',
      },
      { id: 'done', kind: 'complete' },
    ],
  } as TaskProgram;
  const result = validateTaskProgram(invalid);
  assert.equal(result.valid, false);
  assert.equal(result.errors.some((error) => error.includes('undeclared input: secretPath')), true);

  const empty = validateTaskProgram({
    version: 1,
    entry: 'upload',
    steps: [
      { id: 'upload', kind: 'upload', target: { capability: 'upload' }, files: [], next: 'done' },
      { id: 'done', kind: 'complete' },
    ],
  });
  assert.equal(empty.valid, false);
  assert.equal(empty.errors.some((error) => error.includes('requires at least one file')), true);
});
