import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TaskRuntime,
  evaluateTaskPredicate,
  type TaskRuntimeEngine,
} from '../src/agent/taskRuntime.js';
import { validateTaskProgram, type TaskProgram } from '../src/agent/taskProgram.js';
import type { InteractionNode } from '../src/types.js';

function node(id: string, overrides: Partial<InteractionNode> = {}): InteractionNode {
  return {
    id,
    frameId: 'main',
    focused: false,
    disabled: false,
    rect: { x: 0, y: 0, width: 100, height: 20 },
    visibleRect: { x: 0, y: 0, width: 100, height: 20 },
    viewportVisible: true,
    mainViewportVisible: true,
    focusable: true,
    clickable: false,
    editable: false,
    scrollable: false,
    capabilities: [],
    interactionConfidence: 1,
    ...overrides,
  };
}

test('program validation resolves a static control-flow graph and trusted inputs', () => {
  const invalid: TaskProgram = {
    version: 1,
    entry: 'type',
    inputs: ['email'],
    steps: [
      { id: 'type', kind: 'type', target: { role: 'textbox' }, text: { input: 'password' }, next: 'missing' },
    ],
  };
  const validation = validateTaskProgram(invalid);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some((error) => error.includes('undeclared input: password')));
  assert.ok(validation.errors.some((error) => error.includes('missing step: missing')));
});

test('predicate evaluation supports fixed branches over observed browser state', () => {
  const nodes = [node('field', {
    role: 'textbox', name: 'Email', editable: true, capabilities: ['type'], value: 'a@b.test',
  })];
  assert.equal(evaluateTaskPredicate({
    kind: 'state',
    target: { role: 'textbox', name: 'Email' },
    state: { value: { input: 'email' } },
  }, nodes, { email: 'a@b.test' }), true);
});

test('runtime executes predeclared semantic actions, branches, and completion checks', async () => {
  let state: InteractionNode[] = [
    node('email', { role: 'textbox', name: 'Email', editable: true, capabilities: ['type'], value: '' }),
    node('submit', { role: 'button', name: 'Submit', clickable: true, capabilities: ['activate'] }),
  ];
  const calls: unknown[][] = [];
  const engine: TaskRuntimeEngine = {
    async refresh() { return structuredClone(state); },
    async typeInto(query, text, options) {
      calls.push(['type', query, text, options]);
      state = state.map((item) => item.id === 'email' ? { ...item, value: text } : item);
      return { status: 'verified', target: state.find((item) => item.id === 'email') ?? null };
    },
    async activate(query, options) {
      calls.push(['activate', query, options]);
      state = [...state, node('done', { role: 'status', name: 'Saved' })];
      return { status: 'verified', target: state.find((item) => item.id === 'submit') ?? null };
    },
  };

  const program: TaskProgram = {
    version: 1,
    name: 'save-email',
    entry: 'type-email',
    inputs: ['email'],
    steps: [
      {
        id: 'type-email', kind: 'type', target: { role: 'textbox', name: 'Email' },
        text: { input: 'email' }, expectedValue: { input: 'email' }, next: 'check-value',
      },
      {
        id: 'check-value', kind: 'branch',
        condition: { kind: 'state', target: { role: 'textbox', name: 'Email' }, state: { value: { input: 'email' } } },
        then: 'submit', else: 'failed',
      },
      { id: 'submit', kind: 'activate', target: { role: 'button', name: 'Submit' }, next: 'complete' },
      { id: 'complete', kind: 'complete', condition: { kind: 'exists', target: { role: 'status', name: 'Saved' } } },
      { id: 'failed', kind: 'fail' },
    ],
  };

  const result = await new TaskRuntime(engine).run(program, { email: 'frontier@example.test' });
  assert.equal(result.status, 'completed');
  assert.equal(result.completed, true);
  assert.equal(calls[0]?.[2], 'frontier@example.test');
  assert.equal((calls[0]?.[3] as { requireUnambiguous?: boolean }).requireUnambiguous, true);
  assert.equal(calls[1]?.[0], 'activate');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['verified', 'branch-then', 'verified', 'completed']);
  assert.equal(JSON.stringify(result.trace).includes('frontier@example.test'), false);
});

test('external side effects fail closed unless explicitly approved', async () => {
  let activations = 0;
  const state = [node('buy', { role: 'button', name: 'Buy', clickable: true, capabilities: ['activate'] })];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async activate() { activations += 1; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };
  const program: TaskProgram = {
    version: 1,
    entry: 'buy',
    steps: [
      { id: 'buy', kind: 'activate', risk: 'external-side-effect', target: { role: 'button', name: 'Buy' }, next: 'done' },
      { id: 'done', kind: 'complete' },
    ],
  };

  const blocked = await new TaskRuntime(engine).run(program);
  assert.equal(blocked.status, 'policy-blocked');
  assert.equal(activations, 0);

  const allowed = await new TaskRuntime(engine).run(program, {}, { approve: async () => true });
  assert.equal(allowed.status, 'completed');
  assert.equal(activations, 1);
});

test('recovery loops are bounded by semantic no-progress detection', async () => {
  const state = [node('retry', { role: 'button', name: 'Retry', clickable: true, capabilities: ['activate'] })];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async activate() { return { status: 'unverified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };
  const program: TaskProgram = {
    version: 1,
    entry: 'attempt',
    steps: [
      { id: 'attempt', kind: 'activate', target: { role: 'button', name: 'Retry' }, next: 'done', onFailure: 'attempt' },
      { id: 'done', kind: 'complete' },
    ],
  };

  const result = await new TaskRuntime(engine).run(program, {}, {
    maxConsecutiveNoProgress: 2,
    maxVisitsPerStep: 10,
  });
  assert.equal(result.status, 'stalled');
  assert.equal(result.stepsExecuted, 2);
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['failed', 'failed']);
});
