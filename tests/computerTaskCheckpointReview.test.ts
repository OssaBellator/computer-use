import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { createComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';

const task: ComputerTaskProgram = {
  id: 'checkpoint-history-review',
  entry: 'write',
  steps: [{
    kind: 'action',
    id: 'write',
    request: {
      adapterId: 'fake',
      actionId: 'write',
      capability: 'fake.write',
      effect: 'local-reversible',
      idempotency: 'idempotent',
    },
  }],
};

test('checkpoint rejects rollback-shaped not-started cursor after execution advanced', () => {
  assert.throws(
    () => createComputerTaskCheckpoint({
      program: task,
      executionId: EXECUTION_ID,
      nextStepId: 'write',
      stepsExecuted: 1,
      actions: { write: 'not-started' },
    }),
    /cursor\/action history is inconsistent/,
  );
});

test('zero-step checkpoint cannot move cursor away from program entry', () => {
  const twoStepTask: ComputerTaskProgram = {
    id: 'checkpoint-zero-step-review',
    entry: 'read',
    steps: [
      { kind: 'observe', id: 'read', request: { adapterId: 'fake', channel: 'semantic-ui' }, next: 'write' },
      task.steps[0]!,
    ],
  };
  assert.throws(
    () => createComputerTaskCheckpoint({
      program: twoStepTask,
      executionId: EXECUTION_ID,
      nextStepId: 'write',
      stepsExecuted: 0,
      actions: { write: 'not-started' },
    }),
    /zero-step cursor must remain at program entry/,
  );
});
