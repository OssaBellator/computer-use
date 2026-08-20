import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { createComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';
import { LocalFileComputerTaskCheckpointPersistence } from '../src/computer/computerTaskCheckpointPersistence.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const KEY_BYTES = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

const PROGRAM: ComputerTaskProgram = {
  id: 'deterministic-auth-persistence-test',
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

const CHECKPOINT = createComputerTaskCheckpoint({
  program: PROGRAM,
  executionId: EXECUTION_ID,
  nextStepId: 'write',
  stepsExecuted: 0,
  actions: { write: 'not-started' },
});
const BINDING = { program: PROGRAM, executionId: EXECUTION_ID };

async function freshPath(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  return join(directory, 'checkpoint.json');
}

test('fresh stores produce byte-identical authenticated checkpoint and anchor files', async () => {
  const firstPath = await freshPath('computer-checkpoint-determinism-a-');
  const secondPath = await freshPath('computer-checkpoint-determinism-b-');
  const first = new LocalFileComputerTaskCheckpointPersistence({ filePath: firstPath, authenticationKey: KEY_BYTES });
  const second = new LocalFileComputerTaskCheckpointPersistence({ filePath: secondPath, authenticationKey: KEY_BYTES });

  await first.save(CHECKPOINT, BINDING);
  await second.save(CHECKPOINT, BINDING);

  assert.equal(await readFile(first.filePath, 'utf8'), await readFile(second.filePath, 'utf8'));
  assert.equal(await readFile(first.anchorPath, 'utf8'), await readFile(second.anchorPath, 'utf8'));
});

test('constructor snapshots caller-owned authentication key bytes', async () => {
  const filePath = await freshPath('computer-checkpoint-key-snapshot-');
  const callerKey = new Uint8Array(KEY_BYTES);
  const persistence = new LocalFileComputerTaskCheckpointPersistence({ filePath, authenticationKey: callerKey });
  await persistence.save(CHECKPOINT, BINDING);

  callerKey.fill(0);
  const loaded = await persistence.load(BINDING);
  assert.deepEqual(loaded, CHECKPOINT);

  const mutatedKeyStore = new LocalFileComputerTaskCheckpointPersistence({ filePath, authenticationKey: callerKey });
  await assert.rejects(mutatedKeyStore.load(BINDING), /authentication mismatch/);
});
