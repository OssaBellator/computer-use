import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
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
import type { ComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';
import {
  LocalFileComputerTaskCheckpointPersistence,
  type ComputerTaskCheckpointPersistence,
  type ComputerTaskCheckpointPersistenceBinding,
} from '../src/computer/computerTaskCheckpointPersistence.js';
import { DurableComputerTaskRuntime } from '../src/computer/durableComputerTaskRuntime.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'checkpoint-authentication-key-0000000000000001';

function twoActionTask(): ComputerTaskProgram {
  return {
    id: 'durable-progression-test',
    entry: 'first',
    steps: [
      {
        kind: 'action', id: 'first',
        request: { adapterId: 'fake', actionId: 'first', capability: 'fake.write', effect: 'local-reversible', idempotency: 'non-idempotent' },
        onSuccess: 'second',
      },
      {
        kind: 'action', id: 'second',
        request: { adapterId: 'fake', actionId: 'second', capability: 'fake.write', effect: 'local-reversible', idempotency: 'non-idempotent' },
      },
    ],
  };
}

function verifierTask(): ComputerTaskProgram {
  return {
    id: 'durable-verifier-test', entry: 'write',
    steps: [{
      kind: 'action', id: 'write',
      request: { adapterId: 'fake', actionId: 'write', capability: 'fake.write', effect: 'local-reversible', idempotency: 'non-idempotent' },
      verification: 'domain.verify',
    }],
  };
}

class FakeAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor = { id: 'fake', kind: 'desktop-ui' as const, version: '1', capabilities: ['fake.write'] };
  readonly calls: string[] = [];
  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    return { adapterId: 'fake', environment: 'desktop-ui', channel: request.channel, sequence: 1, complete: true, truncated: false, data: undefined };
  }
  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.calls.push(request.actionId);
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
  }
}

function environment() {
  const adapter = new FakeAdapter();
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);
  return { adapter, registry };
}

async function localPersistence() {
  const directory = await mkdtemp(join(tmpdir(), 'durable-progression-'));
  return new LocalFileComputerTaskCheckpointPersistence({ filePath: join(directory, 'checkpoint.json'), authenticationKey: KEY });
}

class FailSaveNumberPersistence implements ComputerTaskCheckpointPersistence {
  saves = 0;
  constructor(readonly inner: ComputerTaskCheckpointPersistence, readonly failSaveNumber: number) {}
  load(binding: ComputerTaskCheckpointPersistenceBinding): Promise<ComputerTaskCheckpoint | undefined> { return this.inner.load(binding); }
  async save(checkpoint: ComputerTaskCheckpoint, binding: ComputerTaskCheckpointPersistenceBinding): Promise<void> {
    this.saves += 1;
    if (this.saves === this.failSaveNumber) throw new Error('planned persistence failure');
    await this.inner.save(checkpoint, binding);
  }
}

test('second action write-ahead carries first action completion across final-save failure', async () => {
  const program = twoActionTask();
  const persistence = await localPersistence();
  const failing = new FailSaveNumberPersistence(persistence, 3);
  const first = environment();
  const runtime = await DurableComputerTaskRuntime.create(program, first.registry, failing, { executionId: EXECUTION_ID });

  assert.equal((await runtime.run()).status, 'reconciliation-required');
  assert.deepEqual(first.adapter.calls, ['first', 'second']);

  const durable = await persistence.load({ program, executionId: EXECUTION_ID });
  assert.ok(durable);
  assert.equal(durable.actions.find((action) => action.stepId === 'first')?.state, 'completed');
  assert.equal(durable.actions.find((action) => action.stepId === 'second')?.state, 'unknown-dispatch');

  const restarted = environment();
  const resumed = await DurableComputerTaskRuntime.create(program, restarted.registry, persistence, { executionId: EXECUTION_ID });
  assert.deepEqual(resumed.pendingReconciliations(), [{ stepId: 'second', state: 'unknown-dispatch' }]);
  assert.equal((await resumed.run()).status, 'reconciliation-required');
  assert.deepEqual(restarted.adapter.calls, []);
});

test('verifier pending subtype replaces generic write-ahead uncertainty after successful final persistence', async () => {
  const program = verifierTask();
  const persistence = await localPersistence();
  const first = environment();
  const runtime = await DurableComputerTaskRuntime.create(program, first.registry, persistence, {
    executionId: EXECUTION_ID,
    hooks: { verifiers: { 'domain.verify': async () => ({ state: 'pending' }) } },
  });

  assert.equal((await runtime.run()).status, 'verification-pending');
  assert.deepEqual(first.adapter.calls, ['write']);

  const restarted = environment();
  const resumed = await DurableComputerTaskRuntime.create(program, restarted.registry, persistence, { executionId: EXECUTION_ID });
  assert.deepEqual(resumed.pendingReconciliations(), [{ stepId: 'write', state: 'verification-pending' }]);
  assert.equal((await resumed.run()).status, 'reconciliation-required');
  assert.deepEqual(restarted.adapter.calls, []);
});
