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

function task(): ComputerTaskProgram {
  return {
    id: 'write-ahead-runtime-test',
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
      sequence: 1, complete: true, truncated: false, data: undefined,
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actCount += 1;
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
  }
}

function environment() {
  const adapter = new FakeAdapter();
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);
  return { adapter, registry };
}

async function localPersistence(program: ComputerTaskProgram) {
  const directory = await mkdtemp(join(tmpdir(), 'durable-computer-runtime-'));
  const persistence = new LocalFileComputerTaskCheckpointPersistence({
    filePath: join(directory, 'checkpoint.json'), authenticationKey: KEY,
  });
  return { persistence, binding: { program, executionId: EXECUTION_ID } };
}

class FailSaveNumberPersistence implements ComputerTaskCheckpointPersistence {
  saves = 0;
  constructor(
    readonly inner: ComputerTaskCheckpointPersistence,
    readonly failSaveNumber: number,
  ) {}
  load(binding: ComputerTaskCheckpointPersistenceBinding): Promise<ComputerTaskCheckpoint | undefined> {
    return this.inner.load(binding);
  }
  async save(checkpoint: ComputerTaskCheckpoint, binding: ComputerTaskCheckpointPersistenceBinding): Promise<void> {
    this.saves += 1;
    if (this.saves === this.failSaveNumber) throw new Error('planned persistence failure');
    await this.inner.save(checkpoint, binding);
  }
}

test('pre-dispatch persistence failure prevents adapter invocation', async () => {
  const program = task();
  const { persistence } = await localPersistence(program);
  const failing = new FailSaveNumberPersistence(persistence, 1);
  const env = environment();
  const runtime = await DurableComputerTaskRuntime.create(program, env.registry, failing, { executionId: EXECUTION_ID });

  const result = await runtime.run();
  assert.equal(result.status, 'failed');
  assert.equal(env.adapter.actCount, 0);
  assert.ok(result.evidence?.includes('checkpoint-persist-failed'));
});

test('failed post-dispatch checkpoint leaves durable unknown state that cannot replay after restart', async () => {
  const program = task();
  const { persistence } = await localPersistence(program);
  const failing = new FailSaveNumberPersistence(persistence, 2);
  const first = environment();
  const runtime = await DurableComputerTaskRuntime.create(program, first.registry, failing, { executionId: EXECUTION_ID });

  const result = await runtime.run();
  assert.equal(result.status, 'reconciliation-required');
  assert.equal(first.adapter.actCount, 1);

  const restarted = environment();
  const resumed = await DurableComputerTaskRuntime.create(program, restarted.registry, persistence, { executionId: EXECUTION_ID });
  assert.deepEqual(resumed.pendingReconciliations(), [{ stepId: 'write', state: 'unknown-dispatch' }]);
  assert.equal((await resumed.run()).status, 'reconciliation-required');
  assert.equal(restarted.adapter.actCount, 0);
});

test('successful run replaces pessimistic write-ahead state with completed checkpoint', async () => {
  const program = task();
  const { persistence } = await localPersistence(program);
  const first = environment();
  const runtime = await DurableComputerTaskRuntime.create(program, first.registry, persistence, { executionId: EXECUTION_ID });
  assert.equal((await runtime.run()).status, 'completed');
  assert.equal(first.adapter.actCount, 1);

  const restarted = environment();
  const resumed = await DurableComputerTaskRuntime.create(program, restarted.registry, persistence, { executionId: EXECUTION_ID });
  assert.equal((await resumed.run()).status, 'completed');
  assert.equal(restarted.adapter.actCount, 0);
});

test('reconciliation assessment cannot redispatch through the provided registry', async () => {
  const program = task();
  const { persistence, binding } = await localPersistence(program);
  const first = environment();
  const runtime = await DurableComputerTaskRuntime.create(program, first.registry, new FailSaveNumberPersistence(persistence, 2), { executionId: EXECUTION_ID });
  assert.equal((await runtime.run()).status, 'reconciliation-required');
  assert.equal(first.adapter.actCount, 1);

  const restart = environment();
  const resumed = await DurableComputerTaskRuntime.create(program, restart.registry, persistence, {
    executionId: EXECUTION_ID,
    hooks: {
      reconcile: async ({ step, registry }) => {
        const attempted = await registry.act(step.request);
        assert.equal(attempted.status, 'rejected');
        assert.equal(attempted.dispatch, 'not-dispatched');
        assert.ok(attempted.evidence?.includes('reconciliation-dispatch-blocked'));
        return { outcome: 'uncertain' };
      },
    },
  });
  assert.deepEqual(await resumed.assessReconciliation('write'), { outcome: 'uncertain', evidence: undefined });
  assert.equal(restart.adapter.actCount, 0);
  assert.equal((await persistence.load(binding))?.actions[0]?.state, 'unknown-dispatch');
});
