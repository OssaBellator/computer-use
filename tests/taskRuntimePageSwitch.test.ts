import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime, type TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import type { TaskProgram } from '../src/agent/taskProgram.js';
import type { InteractionNode } from '../src/types.js';

function node(id: string, name: string): InteractionNode {
  return {
    id,
    frameId: 'main',
    role: 'button',
    name,
    focused: false,
    disabled: false,
    focusable: true,
    clickable: true,
    editable: false,
    scrollable: false,
    capabilities: ['focus', 'activate'],
    interactionConfidence: 1,
  };
}

function targetSummary() {
  return {
    total: 2,
    pages: 2,
    unattachedPages: 1,
    latestPage: {
      targetId: 'page-2', type: 'page', attached: false, sequence: 2,
    },
    latestUnattachedPage: {
      targetId: 'page-2', type: 'page', attached: false, sequence: 2,
    },
  };
}

test('static switch-page action can begin with no active page and continue on the selected page', async () => {
  let active = false;
  const engine: TaskRuntimeEngine = {
    async refresh() { return active ? [node('secondary', 'Secondary Action')] : []; },
    targetState() { return targetSummary(); },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
    async switchPage(target) {
      assert.equal(target, 'latest-page');
      active = true;
      return { status: 'switched', targetId: 'page-2' };
    },
  };
  const program: TaskProgram = {
    version: 1,
    entry: 'switch',
    steps: [
      {
        id: 'switch', kind: 'switch-page', target: 'latest-page',
        next: 'assert-secondary', onFailure: 'failed',
      },
      {
        id: 'assert-secondary', kind: 'assert',
        condition: { kind: 'exists', target: { name: 'Secondary Action' } },
        next: 'done', onFailure: 'failed',
      },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };

  const result = await new TaskRuntime(engine).run(program);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), [
    'page-switched', 'asserted', 'completed',
  ]);
  assert.equal(result.trace[0]?.targetId, 'page-2');
  assert.equal(JSON.stringify(result.trace).includes('Secondary Action'), false);
});

test('latest-unattached-page is a separate static page-selection mode', async () => {
  let selected: string | undefined;
  const engine: TaskRuntimeEngine = {
    async refresh() { return []; },
    targetState() { return targetSummary(); },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
    async switchPage(target) {
      selected = target;
      return { status: 'switched', targetId: 'page-2' };
    },
  };
  const program: TaskProgram = {
    version: 1,
    entry: 'switch',
    steps: [
      {
        id: 'switch', kind: 'switch-page', target: 'latest-unattached-page',
        next: 'done', onFailure: 'failed',
      },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };

  const result = await new TaskRuntime(engine).run(program);
  assert.equal(result.status, 'completed');
  assert.equal(selected, 'latest-unattached-page');
});

test('switch-page fails through its declared recovery edge when no page-switch controller exists', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return []; },
    targetState() { return targetSummary(); },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const program: TaskProgram = {
    version: 1,
    entry: 'switch',
    steps: [
      {
        id: 'switch', kind: 'switch-page', target: 'latest-page',
        next: 'done', onFailure: 'failed',
      },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };

  const result = await new TaskRuntime(engine).run(program, {}, {
    maxConsecutiveNoProgress: 10,
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['failed', 'failed']);
});
