import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime, type TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import { validateTaskProgram, type TaskProgram } from '../src/agent/taskProgram.js';
import type { InteractionNode } from '../src/types.js';

function node(id: string, name: string): InteractionNode {
  return {
    id, frameId: 'main', role: id === 'trigger' ? 'button' : 'menu', name,
    focused: false, disabled: false, focusable: id === 'trigger', clickable: id === 'trigger',
    editable: false, scrollable: false,
    capabilities: id === 'trigger' ? ['focus', 'activate'] : [], interactionConfidence: 1,
  };
}

function program(): TaskProgram {
  return {
    version: 1,
    entry: 'hover',
    steps: [
      {
        id: 'hover', kind: 'hover', target: { name: 'More options' },
        timeoutMs: 250, maxSamples: 5, pollIntervalMs: 5,
        next: 'check', onFailure: 'failed',
      },
      {
        id: 'check', kind: 'assert',
        condition: { kind: 'exists', target: { role: 'menu', name: 'Hover menu' } },
        next: 'done', onFailure: 'failed',
      },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };
}

test('task runtime executes a static verified hover and follows semantic evidence', async () => {
  const trigger = node('trigger', 'More options');
  const overlay = node('overlay', 'Hover menu');
  let state = [trigger];
  let receivedOptions: unknown;
  const engine: TaskRuntimeEngine = {
    async refresh() { return structuredClone(state); },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
    async hover(_query, options) {
      receivedOptions = options;
      state = [trigger, overlay];
      return { status: 'verified', target: trigger };
    },
  };

  const result = await new TaskRuntime(engine).run(program());
  assert.equal(result.status, 'completed');
  assert.deepEqual(receivedOptions, {
    requireUnambiguous: true,
    autoReveal: undefined,
    timeoutMs: 250,
    maxSamples: 5,
    pollIntervalMs: 5,
  });
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['verified', 'asserted', 'completed']);
  assert.equal(JSON.stringify(result.trace).includes('More options'), false);
  assert.equal(JSON.stringify(result.trace).includes('Hover menu'), false);
});

test('missing hover support follows the fixed onFailure edge', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return [node('trigger', 'More options')]; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };

  const result = await new TaskRuntime(engine).run(program(), {}, {
    maxConsecutiveNoProgress: 10,
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['failed', 'failed']);
});

test('hover program validation rejects invalid observation budgets', () => {
  const validation = validateTaskProgram({
    version: 1,
    entry: 'hover',
    steps: [
      {
        id: 'hover', kind: 'hover', target: 'x', next: 'done',
        maxSamples: 0, pollIntervalMs: -1, timeoutMs: 0,
      },
      { id: 'done', kind: 'complete' },
    ],
  });

  assert.equal(validation.valid, false);
  assert.equal(validation.errors.some((error) => error.includes('maxSamples must be a positive integer')), true);
  assert.equal(validation.errors.some((error) => error.includes('pollIntervalMs must be non-negative')), true);
  assert.equal(validation.errors.some((error) => error.includes('timeoutMs must be positive')), true);
});
