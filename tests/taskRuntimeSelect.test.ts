import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime, type TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import { validateTaskProgram, type TaskProgram } from '../src/agent/taskProgram.js';
import type { InteractionNode } from '../src/types.js';

function selectNode(value = 'a'): InteractionNode {
  return {
    id: 'fruit', frameId: 'main', backendNodeId: 7, role: 'select', name: 'Fruit', value,
    focused: false, disabled: false, focusable: true, clickable: true, editable: false,
    scrollable: false, capabilities: ['focus', 'activate', 'select'], interactionConfidence: 1,
  };
}

function program(): TaskProgram {
  return {
    version: 1,
    entry: 'choose',
    inputs: ['desired'],
    steps: [
      {
        id: 'choose', kind: 'select-option', target: { role: 'select', name: 'Fruit' },
        option: { input: 'desired' }, by: 'label', next: 'check', onFailure: 'failed',
      },
      {
        id: 'check', kind: 'assert',
        condition: { kind: 'state', target: { role: 'select', name: 'Fruit' }, state: { value: 'b' } },
        next: 'done', onFailure: 'failed',
      },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };
}

test('task runtime forwards trusted option text and keeps it out of traces', async () => {
  let value = 'a';
  let received: unknown;
  const engine: TaskRuntimeEngine = {
    async refresh() { return [selectNode(value)]; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
    async selectOption(_query, option, options) {
      received = { option, options };
      value = 'b';
      return { status: 'selected', target: selectNode(value), selectedIndex: 1 };
    },
  };
  const secret = 'Banana secret option';
  const result = await new TaskRuntime(engine).run(program(), { desired: secret });

  assert.equal(result.status, 'completed');
  assert.deepEqual(received, {
    option: secret,
    options: { requireUnambiguous: true, by: 'label' },
  });
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['verified', 'asserted', 'completed']);
  assert.equal(JSON.stringify(result.trace).includes(secret), false);
});

test('already-selected verified option counts as successful task progress', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return [selectNode('b')]; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
    async selectOption() {
      return { status: 'already-selected', target: selectNode('b'), selectedIndex: 1 };
    },
  };

  const result = await new TaskRuntime(engine).run(program(), { desired: 'Banana' }, {
    maxConsecutiveNoProgress: 1,
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.trace[0]?.outcome, 'verified');
  assert.equal(result.trace[0]?.browserStateChanged, false);
});

test('missing native select support follows the fixed onFailure edge', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return [selectNode()]; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const result = await new TaskRuntime(engine).run(program(), { desired: 'Banana' }, {
    maxConsecutiveNoProgress: 10,
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['failed', 'failed']);
});

test('select-option validation rejects unsupported matching modes and undeclared inputs', () => {
  const validation = validateTaskProgram({
    version: 1,
    entry: 'choose',
    steps: [
      {
        id: 'choose', kind: 'select-option', target: 'Fruit', option: { input: 'missing' },
        by: 'contains' as 'label', next: 'done',
      },
      { id: 'done', kind: 'complete' },
    ],
  });
  assert.equal(validation.valid, false);
  assert.equal(validation.errors.some((error) => error.includes('by must be label or value')), true);
  assert.equal(validation.errors.some((error) => error.includes('undeclared input: missing')), true);
});
