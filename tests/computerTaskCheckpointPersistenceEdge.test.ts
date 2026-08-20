import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { createComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';
import { LocalFileComputerTaskCheckpointPersistence } from '../src/computer/computerTaskCheckpointPersistence.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'checkpoint-authentication-key-0000000000000001';

function task(): ComputerTaskProgram {
  return {
    id: 'checkpoint-edge-test',
    entry: 'write',
    steps: [{
      kind: 'action',
      id: 'write',
      request: {
        adapterId: 'fake',
        actionId: 'write',
        capability: 'fake.write',
        effect: 'local-reversible',
        idempotency: 'non-idempotent',
      },
    }],
  };
}

async function fixture(program = task()) {
  const directory = await mkdtemp(join(tmpdir(), 'computer-checkpoint-edge-'));
  const filePath = join(directory, 'checkpoint.json');
  return {
    directory,
    filePath,
    persistence: new LocalFileComputerTaskCheckpointPersistence({ filePath, authenticationKey: KEY }),
    binding: { program, executionId: EXECUTION_ID },
  };
}

test('authenticated anchor makes missing primary fail closed as rollback', async () => {
  const program = task();
  const { filePath, persistence, binding } = await fixture(program);
  const checkpoint = createComputerTaskCheckpoint({
    program,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 0,
    actions: { write: 'not-started' },
  });
  await persistence.save(checkpoint, binding);
  await rm(filePath);
  await assert.rejects(persistence.load(binding), /rollback detected/);
  await assert.rejects(persistence.save(checkpoint, binding), /rollback detected/);
});

test('verification pending survives persistence as an explicit reconciliation case', async () => {
  const program = task();
  const { persistence, binding } = await fixture(program);
  const checkpoint = createComputerTaskCheckpoint({
    program,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 1,
    actions: { write: 'dispatched-unverified' },
    uncertainties: { write: 'verification-pending' },
  });
  await persistence.save(checkpoint, binding);
  const loaded = await persistence.load(binding);
  assert.ok(loaded);
  const runtime = new ComputerTaskRuntime(program, new ComputerEnvironmentRegistry(), {
    executionId: EXECUTION_ID,
    checkpoint: loaded,
  });
  assert.deepEqual(runtime.pendingReconciliations(), [{ stepId: 'write', state: 'verification-pending' }]);
  assert.equal((await runtime.run()).status, 'reconciliation-required');
});

test('configured persistence byte bound rejects oversized envelopes', async () => {
  const steps = Array.from({ length: 128 }, (_, index) => ({
    kind: 'action' as const,
    id: `write-${index}`,
    request: {
      adapterId: 'fake',
      actionId: `write-${index}`,
      capability: 'fake.write',
      effect: 'local-reversible' as const,
      idempotency: 'non-idempotent' as const,
    },
  }));
  const program: ComputerTaskProgram = { id: 'large-checkpoint-edge-test', entry: steps[0]!.id, steps };
  const { filePath, binding } = await fixture(program);
  const checkpoint = createComputerTaskCheckpoint({
    program,
    executionId: EXECUTION_ID,
    nextStepId: program.entry,
    stepsExecuted: 0,
    actions: Object.fromEntries(steps.map((step) => [step.id, 'not-started'])),
  });
  const persistence = new LocalFileComputerTaskCheckpointPersistence({
    filePath,
    authenticationKey: KEY,
    maxBytes: 1024,
  });
  await assert.rejects(persistence.save(checkpoint, binding), /exceeds size limit/);
});
