import test from 'node:test';
import assert from 'node:assert/strict';
import { observeTaskEngine } from '../src/agent/taskObservation.js';
import type { TaskRuntimeEngine } from '../src/agent/taskRuntimeContracts.js';

function baseEngine(): TaskRuntimeEngine {
  return {
    async refresh() { return []; },
    async activate() { return { status: 'target-not-found', target: null }; },
    async typeInto() { return { status: 'target-not-found', target: null }; },
  };
}

test('required document observation fails closed when the engine has no document channel', async () => {
  const engine = baseEngine();
  const ordinary = await observeTaskEngine(engine);
  assert.deepEqual(ordinary.nodes, []);

  await assert.rejects(
    observeTaskEngine(engine, { document: true }),
    /Structured document observation is not available/,
  );
});

test('required document observation propagates extraction failure instead of returning an empty predicate state', async () => {
  const engine: TaskRuntimeEngine = {
    ...baseEngine(),
    async documentContent() { throw new Error('frame evaluation failed'); },
  };
  await assert.rejects(
    observeTaskEngine(engine, { document: true }),
    /frame evaluation failed/,
  );
});
