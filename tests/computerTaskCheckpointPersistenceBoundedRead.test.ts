import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { LocalFileComputerTaskCheckpointPersistence } from '../src/computer/computerTaskCheckpointPersistence.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'checkpoint-authentication-key-0000000000000001';
const MAX_BYTES = 1024;

const PROGRAM: ComputerTaskProgram = {
  id: 'bounded-read-test',
  entry: 'write',
  steps: [{
    kind: 'action', id: 'write',
    request: { adapterId: 'fake', actionId: 'write', capability: 'fake.write', effect: 'local-reversible', idempotency: 'non-idempotent' },
  }],
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'checkpoint-bounded-read-'));
  const filePath = join(directory, 'checkpoint.json');
  const persistence = new LocalFileComputerTaskCheckpointPersistence({
    filePath,
    authenticationKey: KEY,
    maxBytes: MAX_BYTES,
  });
  return { persistence, filePath, binding: { program: PROGRAM, executionId: EXECUTION_ID } };
}

test('oversized primary file is rejected at the bounded read seam', async () => {
  const { persistence, filePath, binding } = await fixture();
  // Substantially larger than the configured bound. Production readBounded allocates
  // only maxBytes + 1 and never asks the file handle for bytes beyond that window.
  await writeFile(filePath, Buffer.alloc(8 * 1024 * 1024, 0x61));
  await assert.rejects(persistence.load(binding), /exceeds size limit/);
});

test('oversized anchor file is rejected at the same bounded read seam', async () => {
  const { persistence, filePath, binding } = await fixture();
  await writeFile(`${filePath}.anchor`, Buffer.alloc(8 * 1024 * 1024, 0x62));
  await assert.rejects(persistence.load(binding), /exceeds size limit/);
});
