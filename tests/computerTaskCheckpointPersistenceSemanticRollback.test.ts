import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { createComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';
import { LocalFileComputerTaskCheckpointPersistence } from '../src/computer/computerTaskCheckpointPersistence.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'checkpoint-authentication-key-0000000000000001';

const PROGRAM: ComputerTaskProgram = {
  id: 'semantic-rollback-test',
  entry: 'write',
  steps: [{
    kind: 'action', id: 'write',
    request: { adapterId: 'fake', actionId: 'write', capability: 'fake.write', effect: 'local-reversible', idempotency: 'non-idempotent' },
  }],
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-semantic-rollback-'));
  const persistence = new LocalFileComputerTaskCheckpointPersistence({
    filePath: join(directory, 'checkpoint.json'),
    authenticationKey: KEY,
  });
  const binding = { program: PROGRAM, executionId: EXECUTION_ID };
  return { persistence, binding };
}

test('stale pre-dispatch checkpoint cannot make an uncertain action replayable', async () => {
  const { persistence, binding } = await fixture();
  const uncertain = createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 1,
    actions: { write: 'unknown-dispatch' },
  });
  const stale = createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 0,
    actions: { write: 'not-started' },
  });

  await persistence.save(uncertain, binding);
  await assert.rejects(persistence.save(stale, binding), /semantic rollback detected/);

  const loaded = await persistence.load(binding);
  assert.equal(loaded?.cursor.stepsExecuted, 1);
  assert.equal(loaded?.actions[0]?.state, 'unknown-dispatch');
});

test('completed action cannot regress even behind a numerically newer cursor', async () => {
  const { persistence, binding } = await fixture();
  const completed = createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    stepsExecuted: 1,
    actions: { write: 'completed' },
  });
  const replayable = createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    stepsExecuted: 2,
    actions: { write: 'not-started' },
  });

  await persistence.save(completed, binding);
  await assert.rejects(persistence.save(replayable, binding), /completed action regressed/);
  assert.equal((await persistence.load(binding))?.actions[0]?.state, 'completed');
});

test('same non-replayable action state may advance execution history', async () => {
  const { persistence, binding } = await fixture();
  const first = createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 1,
    actions: { write: 'unknown-dispatch' },
  });
  const later = createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 2,
    actions: { write: 'unknown-dispatch' },
  });

  await persistence.save(first, binding);
  await persistence.save(later, binding);
  assert.equal((await persistence.load(binding))?.cursor.stepsExecuted, 2);
});
