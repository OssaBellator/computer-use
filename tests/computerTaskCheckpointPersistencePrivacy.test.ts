import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { createComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';
import { LocalFileComputerTaskCheckpointPersistence } from '../src/computer/computerTaskCheckpointPersistence.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'checkpoint-authentication-key-0000000000000001';
const BINDING_A = 'trusted-input-revision-alpha-0001';
const BINDING_B = 'trusted-input-revision-beta-0002';

const SENSITIVE_SENTINELS = Object.freeze([
  'raw-action-secret-7f9d2a',
  'terminal-transcript-4c83be',
  'filesystem-contents-c19a0d',
  'cookie-session-token-a71e44',
  'page-excerpt-private-829f31',
  'financial-account-55001122',
  'adapter-observation-data-f2aa10',
]);

function program(checkpointBinding = BINDING_A): ComputerTaskProgram {
  return {
    id: 'persistence-privacy-test',
    entry: 'write',
    steps: [{
      kind: 'action',
      id: 'write',
      request: {
        adapterId: 'fake',
        actionId: 'write',
        capability: 'fake.write',
        effect: 'external-transaction',
        idempotency: 'non-idempotent',
        payload: {
          secret: SENSITIVE_SENTINELS[0],
          terminal: { transcript: SENSITIVE_SENTINELS[1] },
          filesystem: { contents: SENSITIVE_SENTINELS[2] },
          browser: {
            cookie: SENSITIVE_SENTINELS[3],
            excerpt: SENSITIVE_SENTINELS[4],
          },
          financial: { account: SENSITIVE_SENTINELS[5] },
          observation: { data: SENSITIVE_SENTINELS[6] },
        },
      },
      checkpointBinding,
    }],
  };
}

function checkpoint(task: ComputerTaskProgram) {
  return createComputerTaskCheckpoint({
    program: task,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 0,
    actions: { write: 'not-started' },
  });
}

async function storeFor(task: ComputerTaskProgram) {
  const directory = await mkdtemp(join(tmpdir(), 'computer-checkpoint-privacy-'));
  const persistence = new LocalFileComputerTaskCheckpointPersistence({
    filePath: join(directory, 'checkpoint.json'),
    authenticationKey: KEY,
  });
  const binding = { program: task, executionId: EXECUTION_ID };
  await persistence.save(checkpoint(task), binding);
  return { persistence, binding };
}

test('primary and anchor omit representative sensitive payload categories', async () => {
  const task = program();
  const { persistence } = await storeFor(task);
  const primary = await readFile(persistence.filePath, 'utf8');
  const anchor = await readFile(persistence.anchorPath, 'utf8');

  for (const sentinel of SENSITIVE_SENTINELS) {
    assert.equal(primary.includes(sentinel), false, `primary persisted sensitive sentinel: ${sentinel}`);
    assert.equal(anchor.includes(sentinel), false, `anchor persisted sensitive sentinel: ${sentinel}`);
  }
  assert.equal(primary.includes(BINDING_A), false, 'trusted revision must participate only through program digest');
  assert.equal(anchor.includes(BINDING_A), false, 'anchor must not retain trusted revision text');
});

test('changing non-secret trusted checkpoint binding invalidates persisted program identity without storing the binding', async () => {
  const original = program(BINDING_A);
  const changed = program(BINDING_B);
  const { persistence } = await storeFor(original);
  const primary = await readFile(persistence.filePath, 'utf8');

  assert.equal(primary.includes(BINDING_A), false);
  assert.equal(primary.includes(BINDING_B), false);
  await assert.rejects(
    persistence.load({ program: changed, executionId: EXECUTION_ID }),
    /binding/,
  );
});
