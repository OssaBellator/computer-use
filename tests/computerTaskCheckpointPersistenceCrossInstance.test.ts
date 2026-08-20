import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { createComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';
import { LocalFileComputerTaskCheckpointPersistence } from '../src/computer/computerTaskCheckpointPersistence.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'checkpoint-authentication-key-0000000000000001';

const PROGRAM: ComputerTaskProgram = {
  id: 'cross-instance-save-test',
  entry: 'write',
  steps: [{
    kind: 'action', id: 'write',
    request: { adapterId: 'fake', actionId: 'write', capability: 'fake.write', effect: 'local-reversible', idempotency: 'non-idempotent' },
  }],
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-cross-instance-'));
  const filePath = join(directory, 'checkpoint.json');
  const options = { filePath, authenticationKey: KEY };
  return {
    first: new LocalFileComputerTaskCheckpointPersistence(options),
    second: new LocalFileComputerTaskCheckpointPersistence(options),
    binding: { program: PROGRAM, executionId: EXECUTION_ID },
  };
}

function initialCheckpoint() {
  return createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 0,
    actions: { write: 'not-started' },
  });
}

function completedCheckpoint() {
  return createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    stepsExecuted: 1,
    actions: { write: 'completed' },
  });
}

test('separate local persistence instances cannot race a completed action back to replayable state', async () => {
  const { first, second, binding } = await fixture();
  const stale = initialCheckpoint();
  await first.save(stale, binding);

  const results = await Promise.allSettled([
    first.save(completedCheckpoint(), binding),
    second.save(stale, binding),
  ]);

  assert.ok(results.some((result) => result.status === 'fulfilled'));
  const loaded = await first.load(binding);
  assert.equal(loaded?.actions[0]?.state, 'completed');
  assert.equal(loaded?.cursor.stepsExecuted, 1);
});

test('existing save lock fails closed and leaves durable checkpoint unchanged', async () => {
  const { first, second, binding } = await fixture();
  const initial = initialCheckpoint();
  await first.save(initial, binding);
  await writeFile(second.lockPath, 'operator-must-confirm-writer-death-before-removal', { mode: 0o600 });

  await assert.rejects(
    second.save(completedCheckpoint(), binding),
    /busy or a stale lock requires explicit operator recovery/,
  );
  assert.deepEqual(await first.load(binding), initial);
});
