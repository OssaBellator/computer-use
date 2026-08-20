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
  ComputerEntityRef,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { createComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';
import { LocalFileComputerTaskCheckpointPersistence } from '../src/computer/computerTaskCheckpointPersistence.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'checkpoint-authentication-key-0000000000000001';
const TARGET: ComputerEntityRef = {
  adapterId: 'fake',
  environment: 'desktop-ui',
  kind: 'ui-control',
  entityId: 'control:1',
  generation: 1,
};

function task(): ComputerTaskProgram {
  return {
    id: 'reconciliation-durability-test',
    entry: 'write',
    steps: [{
      kind: 'action',
      id: 'write',
      request: {
        adapterId: 'fake',
        actionId: 'write',
        capability: 'fake.write',
        effect: 'external-communication',
        idempotency: 'non-idempotent',
        target: TARGET,
      },
      target: { entity: TARGET },
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
      adapterId: 'fake',
      environment: 'desktop-ui',
      channel: request.channel,
      sequence: 1,
      complete: true,
      truncated: false,
      target: request.target,
      data: undefined,
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

async function persistence(program: ComputerTaskProgram) {
  const directory = await mkdtemp(join(tmpdir(), 'computer-reconciliation-'));
  const store = new LocalFileComputerTaskCheckpointPersistence({
    filePath: join(directory, 'checkpoint.json'),
    authenticationKey: KEY,
  });
  return { store, binding: { program, executionId: EXECUTION_ID } };
}

function uncertainCheckpoint(program: ComputerTaskProgram) {
  return createComputerTaskCheckpoint({
    program,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 1,
    actions: { write: 'unknown-dispatch' },
  });
}

test('completed reconciliation remains skipped after a second durable restart', async () => {
  const program = task();
  const { store, binding } = await persistence(program);
  const firstEnvironment = environment();
  const runtime = new ComputerTaskRuntime(program, firstEnvironment.registry, {
    executionId: EXECUTION_ID,
    checkpoint: uncertainCheckpoint(program),
  });

  runtime.resolveReconciliation('write', 'completed');
  await store.save(runtime.checkpoint(), binding);
  const loaded = await store.load(binding);
  assert.ok(loaded);

  const restarted = environment();
  const result = await new ComputerTaskRuntime(program, restarted.registry, {
    executionId: EXECUTION_ID,
    checkpoint: loaded,
  }).run();
  assert.equal(result.status, 'completed');
  assert.equal(restarted.adapter.actCount, 0);
});

test('not-dispatched reconciliation remains subject to fresh target revalidation after restart', async () => {
  const program = task();
  const { store, binding } = await persistence(program);
  const runtime = new ComputerTaskRuntime(program, environment().registry, {
    executionId: EXECUTION_ID,
    checkpoint: uncertainCheckpoint(program),
  });
  runtime.resolveReconciliation('write', 'not-dispatched');
  await store.save(runtime.checkpoint(), binding);
  const loaded = await store.load(binding);
  assert.ok(loaded);

  const stale = environment();
  const staleResult = await new ComputerTaskRuntime(program, stale.registry, {
    executionId: EXECUTION_ID,
    checkpoint: loaded,
    hooks: {
      approve: async () => true,
      revalidateTarget: async () => ({ state: 'stale', entity: { ...TARGET, generation: 2 } }),
    },
  }).run();
  assert.equal(staleResult.status, 'stale-target');
  assert.equal(stale.adapter.actCount, 0);

  const fresh = environment();
  let revalidations = 0;
  const freshResult = await new ComputerTaskRuntime(program, fresh.registry, {
    executionId: EXECUTION_ID,
    checkpoint: loaded,
    hooks: {
      approve: async () => true,
      revalidateTarget: async () => {
        revalidations += 1;
        return { state: 'fresh', entity: TARGET };
      },
    },
  }).run();
  assert.equal(freshResult.status, 'completed');
  assert.equal(fresh.adapter.actCount, 1);
  assert.ok(revalidations >= 2, 'resolved redispatch must pass normal initial and pre-dispatch freshness checks');
});
