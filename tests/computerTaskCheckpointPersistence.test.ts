import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { createComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';
import { LocalFileComputerTaskCheckpointPersistence } from '../src/computer/computerTaskCheckpointPersistence.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'checkpoint-authentication-key-0000000000000001';
const WRONG_KEY = 'checkpoint-authentication-key-0000000000000002';
const SECRET = 'raw-action-payload-must-never-be-persisted';

function task(payload: unknown = undefined): ComputerTaskProgram {
  return {
    id: 'durable-checkpoint-test',
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
        payload,
      },
      checkpointBinding: payload === undefined ? undefined : 'trusted-revision-0001',
    }],
  };
}

class FakeAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor = {
    id: 'fake',
    kind: 'desktop-ui' as const,
    version: '1',
    capabilities: ['fake.write'],
  };
  actCount = 0;

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    return {
      adapterId: 'fake', environment: 'desktop-ui', channel: request.channel,
      sequence: 1, complete: true, truncated: false, data: { secret: 'observation-data-must-not-persist' },
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actCount += 1;
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
  }
}

function registry(): { registry: ComputerEnvironmentRegistry; adapter: FakeAdapter } {
  const adapter = new FakeAdapter();
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);
  return { registry, adapter };
}

async function fixture(program = task()) {
  const directory = await mkdtemp(join(tmpdir(), 'computer-checkpoint-'));
  const filePath = join(directory, 'checkpoint.json');
  const persistence = new LocalFileComputerTaskCheckpointPersistence({ filePath, authenticationKey: KEY });
  return { directory, filePath, persistence, binding: { program, executionId: EXECUTION_ID } };
}

function checkpoint(program: ComputerTaskProgram, state: 'not-started' | 'completed' | 'dispatched-unverified' | 'unknown-dispatch' = 'not-started') {
  return createComputerTaskCheckpoint({
    program,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: state === 'not-started' ? 0 : 1,
    actions: { write: state },
  });
}

test('persisted checkpoint detects tampering independently of the inner corruption hash', async () => {
  const program = task();
  const { persistence, binding, filePath } = await fixture(program);
  await persistence.save(checkpoint(program), binding);
  const encoded = await readFile(filePath, 'utf8');
  assert.match(encoded, /hmac-sha256/);
  await writeFile(filePath, encoded.replace('"generation":1', '"generation":2'), 'utf8');
  await assert.rejects(persistence.load(binding), /authentication mismatch/);
});

test('persisted checkpoint rejects the wrong authentication key', async () => {
  const program = task();
  const { persistence, binding, filePath } = await fixture(program);
  await persistence.save(checkpoint(program), binding);
  const wrong = new LocalFileComputerTaskCheckpointPersistence({ filePath, authenticationKey: WRONG_KEY });
  await assert.rejects(wrong.load(binding), /authentication mismatch/);
});

test('authenticated anchor detects rollback to a stale checkpoint file', async () => {
  const program = task();
  const { persistence, binding, filePath } = await fixture(program);
  await persistence.save(checkpoint(program), binding);
  const oldPrimary = await readFile(filePath, 'utf8');
  await persistence.save(checkpoint(program), binding);
  await writeFile(filePath, oldPrimary, 'utf8');
  await assert.rejects(persistence.load(binding), /rollback detected/);
});

test('partial primary write fails closed', async () => {
  const program = task();
  const { persistence, binding, filePath } = await fixture(program);
  await persistence.save(checkpoint(program), binding);
  await writeFile(filePath, '{"format":', 'utf8');
  await assert.rejects(persistence.load(binding), /invalid persisted computer task checkpoint JSON/);
});

test('crash after temp write but before replace leaves the committed checkpoint readable', async () => {
  const program = task();
  const { persistence, binding } = await fixture(program);
  const committed = checkpoint(program, 'completed');
  await persistence.save(committed, binding);
  await writeFile(persistence.tempPath, 'partial-new-generation', 'utf8');
  const loaded = await persistence.load(binding);
  assert.equal(loaded?.actions[0]?.state, 'completed');
});

test('unknown dispatch survives restart and cannot replay without explicit resolution', async () => {
  const program = task();
  const { persistence, binding } = await fixture(program);
  await persistence.save(checkpoint(program, 'unknown-dispatch'), binding);
  const loaded = await persistence.load(binding);
  assert.ok(loaded);
  const environment = registry();
  const runtime = new ComputerTaskRuntime(program, environment.registry, { executionId: EXECUTION_ID, checkpoint: loaded });
  assert.deepEqual(runtime.pendingReconciliations(), [{ stepId: 'write', state: 'unknown-dispatch' }]);
  assert.equal((await runtime.run()).status, 'reconciliation-required');
  assert.equal(environment.adapter.actCount, 0);
});

test('reconciliation assessment is advisory and explicit successful resolution permits continuation', async () => {
  const program = task();
  const { persistence, binding } = await fixture(program);
  await persistence.save(checkpoint(program, 'unknown-dispatch'), binding);
  const loaded = await persistence.load(binding);
  assert.ok(loaded);
  const environment = registry();
  const runtime = new ComputerTaskRuntime(program, environment.registry, {
    executionId: EXECUTION_ID,
    checkpoint: loaded,
    hooks: { reconcile: async () => ({ outcome: 'completed', evidence: ['domain-confirmed'] }) },
  });
  assert.deepEqual(await runtime.assessReconciliation('write'), { outcome: 'completed', evidence: ['domain-confirmed'] });
  assert.equal((await runtime.run()).status, 'reconciliation-required', 'assessment alone must not unblock execution');
  runtime.resolveReconciliation('write', 'completed');
  assert.equal((await runtime.run()).status, 'completed');
  assert.equal(environment.adapter.actCount, 0);
});

test('explicit not-dispatched resolution may redispatch only through the normal fresh execution path', async () => {
  const program = task();
  const environment = registry();
  const runtime = new ComputerTaskRuntime(program, environment.registry, {
    executionId: EXECUTION_ID,
    checkpoint: checkpoint(program, 'unknown-dispatch'),
  });
  runtime.resolveReconciliation('write', 'not-dispatched');
  assert.equal((await runtime.run()).status, 'completed');
  assert.equal(environment.adapter.actCount, 1);
});

test('completed action remains skipped after durable restart', async () => {
  const program = task();
  const { persistence, binding } = await fixture(program);
  await persistence.save(checkpoint(program, 'completed'), binding);
  const loaded = await persistence.load(binding);
  assert.ok(loaded);
  const environment = registry();
  assert.equal((await new ComputerTaskRuntime(program, environment.registry, { executionId: EXECUTION_ID, checkpoint: loaded }).run()).status, 'completed');
  assert.equal(environment.adapter.actCount, 0);
});

test('verification mismatch subtype is durable for reconciliation', async () => {
  const program = task();
  const { persistence, binding } = await fixture(program);
  const uncertain = createComputerTaskCheckpoint({
    program,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 1,
    actions: { write: 'dispatched-unverified' },
    uncertainties: { write: 'verification-mismatch' },
  });
  await persistence.save(uncertain, binding);
  const loaded = await persistence.load(binding);
  assert.ok(loaded);
  const environment = registry();
  const runtime = new ComputerTaskRuntime(program, environment.registry, { executionId: EXECUTION_ID, checkpoint: loaded });
  assert.deepEqual(runtime.pendingReconciliations(), [{ stepId: 'write', state: 'verification-mismatch' }]);
  assert.equal((await runtime.run()).status, 'reconciliation-required');
  assert.equal(environment.adapter.actCount, 0);
});

test('durable checkpoint omits raw action payload and trusted binding material', async () => {
  const program = task(SECRET);
  const { persistence, binding, filePath } = await fixture(program);
  await persistence.save(checkpoint(program), binding);
  const primary = await readFile(filePath, 'utf8');
  const anchor = await readFile(persistence.anchorPath, 'utf8');
  assert.equal(primary.includes(SECRET), false);
  assert.equal(primary.includes('trusted-revision-0001'), false);
  assert.equal(primary.includes('observation-data-must-not-persist'), false);
  assert.equal(anchor.includes(SECRET), false);
});

test('persisted checkpoint remains bound to execution and program identity', async () => {
  const program = task();
  const { persistence, binding } = await fixture(program);
  await persistence.save(checkpoint(program), binding);
  await assert.rejects(
    persistence.load({ program, executionId: 'fedcba9876543210fedcba9876543210' }),
    /binding/,
  );
  const changed = { ...program, id: 'different-program-id' };
  await assert.rejects(persistence.load({ program: changed, executionId: EXECUTION_ID }), /binding/);
});
