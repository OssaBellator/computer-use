import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime, type TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import { validateTaskProgram, type TaskProgram } from '../src/agent/taskProgram.js';
import type { InteractionNode } from '../src/types.js';

function node(id: string, focused: boolean): InteractionNode {
  return { id, frameId: 'main', role: id === 'first' ? 'textbox' : 'button', name: id, focused, disabled: false, focusable: true, clickable: id !== 'first', editable: id === 'first', scrollable: false, capabilities: id === 'first' ? ['focus', 'type'] : ['focus', 'activate'], interactionConfidence: 1 };
}
function program(key = 'Control+K'): TaskProgram {
  return { version: 1, entry: 'press', steps: [
    { id: 'press', kind: 'press-key', key, next: 'check', onFailure: 'failed' },
    { id: 'check', kind: 'assert', condition: { kind: 'state', target: { name: 'second' }, state: { focused: true } }, next: 'done', onFailure: 'failed' },
    { id: 'done', kind: 'complete' },
    { id: 'failed', kind: 'fail' },
  ] };
}

test('task runtime executes a static verified key action without copying the chord into traces', async () => {
  let state = [node('first', true), node('second', false)];
  let received = '';
  const engine: TaskRuntimeEngine = {
    async refresh() { return structuredClone(state); },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
    async pressKey(key) { received = key; state = [node('first', false), node('second', true)]; return { status: 'verified' }; },
  };
  const result = await new TaskRuntime(engine).run(program());
  assert.equal(result.status, 'completed');
  assert.equal(received, 'Control+K');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['verified', 'asserted', 'completed']);
  assert.equal(JSON.stringify(result.trace).includes('Control+K'), false);
});

test('missing key-action support follows the fixed onFailure edge', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return [node('first', true), node('second', false)]; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const result = await new TaskRuntime(engine).run(program('Escape'), {}, { maxConsecutiveNoProgress: 10 });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['failed', 'failed']);
});

test('press-key program validation rejects empty keys and invalid observation budgets', () => {
  const validation = validateTaskProgram({
    version: 1,
    entry: 'press',
    steps: [
      { id: 'press', kind: 'press-key', key: ' ', next: 'done', maxSamples: 0, pollIntervalMs: -1, timeoutMs: 0 },
      { id: 'done', kind: 'complete' },
    ],
  });
  assert.equal(validation.valid, false);
  assert.equal(validation.errors.some((error) => error.includes('key must be non-empty')), true);
  assert.equal(validation.errors.some((error) => error.includes('maxSamples must be a positive integer')), true);
  assert.equal(validation.errors.some((error) => error.includes('pollIntervalMs must be non-negative')), true);
  assert.equal(validation.errors.some((error) => error.includes('timeoutMs must be positive')), true);
});
