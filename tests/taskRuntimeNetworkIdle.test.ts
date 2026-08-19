import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime, type TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import { validateTaskProgram, type TaskProgram } from '../src/agent/taskProgram.js';

function program(): TaskProgram {
  return {
    version: 1,
    entry: 'quiet',
    steps: [
      {
        id: 'quiet', kind: 'wait-network-idle', quietMs: 25, maxInflight: 1,
        timeoutMs: 250, pollIntervalMs: 5, next: 'done', onTimeout: 'failed',
      },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };
}

test('task runtime executes network-idle waits as observe-only steps', async () => {
  let options: unknown;
  let approvals = 0;
  const engine: TaskRuntimeEngine = {
    async refresh() { return []; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
    async waitForNetworkIdle(received) {
      options = received;
      return {
        idle: true,
        summary: { inFlight: 0, started: 3, finished: 3, failed: 0, activitySequence: 6 },
        elapsedMs: 30,
        samples: 4,
      };
    },
  };

  const result = await new TaskRuntime(engine).run(program(), {}, {
    maxRisk: 'observe',
    approve: async () => { approvals += 1; return false; },
  });

  assert.equal(result.status, 'completed');
  assert.equal(approvals, 0);
  assert.deepEqual(options, { quietMs: 25, maxInflight: 1, timeoutMs: 250, pollIntervalMs: 5 });
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['wait-satisfied', 'completed']);
  assert.equal(JSON.stringify(result.trace).includes('started'), false);
});

test('missing network monitor follows the fixed timeout edge', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return []; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const result = await new TaskRuntime(engine).run(program());
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['wait-timeout', 'failed']);
});

test('network-idle task validation rejects invalid observation budgets', () => {
  const validation = validateTaskProgram({
    version: 1,
    entry: 'quiet',
    steps: [
      {
        id: 'quiet', kind: 'wait-network-idle', quietMs: -1, maxInflight: -1,
        timeoutMs: -1, pollIntervalMs: -1, next: 'done',
      },
      { id: 'done', kind: 'complete' },
    ],
  });
  assert.equal(validation.valid, false);
  assert.equal(validation.errors.some((error) => error.includes('quietMs must be non-negative')), true);
  assert.equal(validation.errors.some((error) => error.includes('maxInflight must be a non-negative integer')), true);
  assert.equal(validation.errors.some((error) => error.includes('timeoutMs must be non-negative')), true);
  assert.equal(validation.errors.some((error) => error.includes('pollIntervalMs must be non-negative')), true);
});
