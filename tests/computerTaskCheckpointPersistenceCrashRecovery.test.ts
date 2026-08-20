import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { createComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';
import { LocalFileComputerTaskCheckpointPersistence } from '../src/computer/computerTaskCheckpointPersistence.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'checkpoint-authentication-key-0000000000000001';

function program(): ComputerTaskProgram {
  return {
    id: 'crash-recovery-checkpoint-test',
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

function checkpoint(task: ComputerTaskProgram, state: 'not-started' | 'completed' = 'not-started') {
  return createComputerTaskCheckpoint({
    program: task,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: state === 'completed' ? 1 : 0,
    actions: { write: state },
  });
}

async function fixture() {
  const task = program();
  const directory = await mkdtemp(join(tmpdir(), 'computer-checkpoint-crash-'));
  const filePath = join(directory, 'checkpoint.json');
  const persistence = new LocalFileComputerTaskCheckpointPersistence({ filePath, authenticationKey: KEY });
  const binding = { program: task, executionId: EXECUTION_ID };
  return { task, persistence, binding };
}

test('older authenticated anchor is healed after primary replace completed first', async () => {
  const { task, persistence, binding } = await fixture();
  await persistence.save(checkpoint(task), binding);
  const oldAnchor = await readFile(persistence.anchorPath, 'utf8');
  await persistence.save(checkpoint(task, 'completed'), binding);
  await writeFile(persistence.anchorPath, oldAnchor, 'utf8');

  const loaded = await persistence.load(binding);
  assert.equal(loaded?.actions[0]?.state, 'completed');
  assert.notEqual(await readFile(persistence.anchorPath, 'utf8'), oldAnchor);
});

test('partial anchor write fails closed rather than accepting an unauthenticated high-water mark', async () => {
  const { task, persistence, binding } = await fixture();
  await persistence.save(checkpoint(task), binding);
  await writeFile(persistence.anchorPath, '{"format":', 'utf8');
  await assert.rejects(persistence.load(binding), /invalid persisted computer task checkpoint anchor JSON/);
});

test('orphaned primary temp file never overrides the committed primary', async () => {
  const { task, persistence, binding } = await fixture();
  await persistence.save(checkpoint(task, 'completed'), binding);
  await writeFile(persistence.tempPath, '{"forged":"uncommitted"}', 'utf8');
  const loaded = await persistence.load(binding);
  assert.equal(loaded?.actions[0]?.state, 'completed');
});

test('orphaned anchor temp file never overrides the committed anchor', async () => {
  const { task, persistence, binding } = await fixture();
  await persistence.save(checkpoint(task, 'completed'), binding);
  await writeFile(`${persistence.anchorPath}.tmp`, '{"forged":"uncommitted"}', 'utf8');
  const loaded = await persistence.load(binding);
  assert.equal(loaded?.actions[0]?.state, 'completed');
});
