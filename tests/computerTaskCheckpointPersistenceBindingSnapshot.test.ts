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
  id: 'direct-binding-snapshot-test',
  entry: 'write',
  steps: [{
    kind: 'action', id: 'write',
    request: { adapterId: 'fake', actionId: 'write', capability: 'fake.write', effect: 'local-reversible', idempotency: 'non-idempotent' },
  }],
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-binding-snapshot-'));
  return new LocalFileComputerTaskCheckpointPersistence({
    filePath: join(directory, 'checkpoint.json'),
    authenticationKey: KEY,
  });
}

function mutableBinding() {
  return {
    program: JSON.parse(JSON.stringify(PROGRAM)) as ComputerTaskProgram,
    executionId: EXECUTION_ID,
  };
}

test('direct save snapshots binding synchronously before filesystem awaits', async () => {
  const persistence = await fixture();
  const binding = mutableBinding();
  const checkpoint = createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 0,
    actions: { write: 'not-started' },
  });

  const save = persistence.save(checkpoint, binding);
  binding.program.id = 'mutated-after-save-call';
  binding.executionId = 'ffffffffffffffffffffffffffffffff';
  await save;

  const loaded = await persistence.load({ program: PROGRAM, executionId: EXECUTION_ID });
  assert.equal(loaded?.program.id, PROGRAM.id);
  assert.equal(loaded?.execution.id, EXECUTION_ID);
});

test('direct load snapshots binding synchronously before filesystem awaits', async () => {
  const persistence = await fixture();
  const checkpoint = createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 0,
    actions: { write: 'not-started' },
  });
  await persistence.save(checkpoint, { program: PROGRAM, executionId: EXECUTION_ID });

  const binding = mutableBinding();
  const load = persistence.load(binding);
  binding.program.id = 'mutated-after-load-call';
  binding.executionId = 'ffffffffffffffffffffffffffffffff';

  assert.deepEqual(await load, checkpoint);
});

test('binding accessors are rejected without invocation', async () => {
  const persistence = await fixture();
  let getterCalls = 0;
  const binding: Record<string, unknown> = { executionId: EXECUTION_ID };
  Object.defineProperty(binding, 'program', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return PROGRAM;
    },
  });

  await assert.rejects(
    persistence.load(binding as unknown as { program: ComputerTaskProgram; executionId: string }),
    /own data properties/,
  );
  assert.equal(getterCalls, 0);
});
