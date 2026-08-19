import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime, type TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import { validateTaskProgram, type TaskProgram } from '../src/agent/taskProgram.js';
import type { InteractionNode, Point } from '../src/types.js';

function node(y: number): InteractionNode {
  return {
    id: 'item', frameId: 'main', role: 'button', name: 'Item', focused: false,
    disabled: false, focusable: true, clickable: true, editable: false, scrollable: false,
    capabilities: ['focus', 'activate'], interactionConfidence: 1,
    rect: { x: 100, y, width: 100, height: 40 },
    mainViewportRect: { x: 100, y, width: 100, height: 40 },
    viewportVisible: true, mainViewportVisible: true,
  };
}

function singleScrollProgram(): TaskProgram {
  return {
    version: 1,
    entry: 'scroll',
    steps: [
      {
        id: 'scroll', kind: 'scroll-viewport', deltaY: 320,
        timeoutMs: 250, maxSamples: 5, pollIntervalMs: 5,
        next: 'done', onFailure: 'failed',
      },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };
}

test('task runtime forwards bounded viewport scroll options', async () => {
  let receivedDelta: Point | undefined;
  let receivedOptions: unknown;
  let y = 500;
  const engine: TaskRuntimeEngine = {
    async refresh() { return [node(y)]; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
    async scrollViewport(delta, options) {
      receivedDelta = delta;
      receivedOptions = options;
      y -= delta.y;
      return { status: 'verified' };
    },
  };

  const result = await new TaskRuntime(engine).run(singleScrollProgram());
  assert.equal(result.status, 'completed');
  assert.deepEqual(receivedDelta, { x: 0, y: 320 });
  assert.deepEqual(receivedOptions, { timeoutMs: 250, maxSamples: 5, pollIntervalMs: 5 });
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['verified', 'completed']);
});

test('verified geometry-only scrolls do not trip the semantic no-progress guard', async () => {
  let y = 1000;
  const engine: TaskRuntimeEngine = {
    async refresh() { return [node(y)]; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
    async scrollViewport(delta) {
      y -= delta.y;
      return { status: 'verified' };
    },
  };
  const steps = Array.from({ length: 5 }, (_, index) => ({
    id: `s${index + 1}`,
    kind: 'scroll-viewport' as const,
    deltaY: 100,
    next: index === 4 ? 'done' : `s${index + 2}`,
  }));
  const result = await new TaskRuntime(engine).run({
    version: 1,
    entry: 's1',
    steps: [...steps, { id: 'done', kind: 'complete' }],
  });

  assert.equal(result.status, 'completed');
  assert.equal(result.trace.filter((entry) => entry.kind === 'scroll-viewport').length, 5);
});

test('missing scroll support follows the fixed onFailure edge', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return [node(500)]; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const result = await new TaskRuntime(engine).run(singleScrollProgram(), {}, {
    maxConsecutiveNoProgress: 10,
  });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['failed', 'failed']);
});

test('scroll task validation rejects zero, oversized, non-finite, and invalid settle budgets', () => {
  const validation = validateTaskProgram({
    version: 1,
    entry: 'zero',
    steps: [
      { id: 'zero', kind: 'scroll-viewport', next: 'large' },
      { id: 'large', kind: 'scroll-viewport', deltaY: 4001, next: 'bad' },
      {
        id: 'bad', kind: 'scroll-viewport', deltaX: Number.POSITIVE_INFINITY,
        deltaY: 1, maxSamples: 0, pollIntervalMs: -1, timeoutMs: 0, next: 'done',
      },
      { id: 'done', kind: 'complete' },
    ],
  });

  assert.equal(validation.valid, false);
  assert.equal(validation.errors.some((error) => error.includes('requires a non-zero delta')), true);
  assert.equal(validation.errors.some((error) => error.includes('must not exceed 4000px per axis')), true);
  assert.equal(validation.errors.some((error) => error.includes('deltas must be finite')), true);
  assert.equal(validation.errors.some((error) => error.includes('maxSamples must be a positive integer')), true);
  assert.equal(validation.errors.some((error) => error.includes('pollIntervalMs must be non-negative')), true);
  assert.equal(validation.errors.some((error) => error.includes('timeoutMs must be positive')), true);
});
