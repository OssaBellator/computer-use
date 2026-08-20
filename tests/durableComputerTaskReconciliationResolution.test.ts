import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEntityRef,
  ComputerEnvironmentAdapter,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
  ComputerSurfaceRef,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { createComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';
import { LocalFileComputerTaskCheckpointPersistence } from '../src/computer/computerTaskCheckpointPersistence.js';
import { DurableComputerTaskRuntime } from '../src/computer/durableComputerTaskRuntime.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'checkpoint-authentication-key-0000000000000001';

function surface(generation = 1): ComputerSurfaceRef {
  return { adapterId: 'fake', environment: 'desktop-ui', surfaceId: 'surface:1', generation };
}

function entity(generation = 1): ComputerEntityRef {
  return {
    adapterId: 'fake', environment: 'desktop-ui', kind: 'ui-control',
    entityId: 'entity:1', surfaceId: 'surface:1', generation,
  };
}

const PROGRAM: ComputerTaskProgram = {
  id: 'durable-resolution-test',
  entry: 'write',
  steps: [{
    kind: 'action',
    id: 'write',
    request: {
      adapterId: 'fake', actionId: 'write', capability: 'fake.write',
      effect: 'local-reversible', idempotency: 'non-idempotent', target: entity(),
    },
    target: { surface: surface(), entity: entity() },
  }],
};

class FakeAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor = { id: 'fake', kind: 'desktop-ui' as const, version: '1', capabilities: ['fake.write'] };
  actCount = 0;
  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    return {
      adapterId: 'fake', environment: 'desktop-ui', channel: request.channel,
      sequence: 1, complete: true, truncated: false, surface: surface(), target: entity(), data: undefined,
    };
  }
  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actCount += 1;
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
  }
}

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'durable-resolution-'));
  const persistence = new LocalFileComputerTaskCheckpointPersistence({
    filePath: join(directory, 'checkpoint.json'), authenticationKey: KEY,
  });
  const adapter = new FakeAdapter();
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);
  const binding = { program: PROGRAM, executionId: EXECUTION_ID };
  await persistence.save(createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 1,
    actions: { write: 'unknown-dispatch' },
  }), binding);
  return { persistence, adapter, registry, binding };
}

test('explicit not-dispatched resolution survives restart and still revalidates before dispatch', async () => {
  const { persistence, adapter, registry, binding } = await fixture();
  const first = await DurableComputerTaskRuntime.create(PROGRAM, registry, persistence, { executionId: EXECUTION_ID });
  assert.deepEqual(first.pendingReconciliations(), [{ stepId: 'write', state: 'unknown-dispatch' }]);

  first.resolveReconciliation('write', 'not-dispatched');
  assert.equal(first.checkpoint().actions[0]?.state, 'reconciled-not-dispatched');
  await first.persistCheckpoint();
  assert.equal((await persistence.load(binding))?.actions[0]?.state, 'reconciled-not-dispatched');

  let revalidations = 0;
  const restarted = await DurableComputerTaskRuntime.create(PROGRAM, registry, persistence, {
    executionId: EXECUTION_ID,
    hooks: {
      revalidateTarget: async () => {
        revalidations += 1;
        return { state: 'fresh', surface: surface(), entity: entity() };
      },
    },
  });
  assert.deepEqual(restarted.pendingReconciliations(), []);
  assert.equal((await restarted.run()).status, 'completed');
  assert.equal(adapter.actCount, 1);
  assert.ok(revalidations >= 2);
  assert.equal((await persistence.load(binding))?.actions[0]?.state, 'completed');
});

test('durable not-dispatched resolution does not bypass stale-target protection after restart', async () => {
  const { persistence, adapter, registry, binding } = await fixture();
  const first = await DurableComputerTaskRuntime.create(PROGRAM, registry, persistence, { executionId: EXECUTION_ID });
  first.resolveReconciliation('write', 'not-dispatched');
  await first.persistCheckpoint();

  const restarted = await DurableComputerTaskRuntime.create(PROGRAM, registry, persistence, {
    executionId: EXECUTION_ID,
    hooks: { revalidateTarget: async () => ({ state: 'stale', surface: surface(2), entity: entity(2) }) },
  });
  const result = await restarted.run();
  assert.equal(result.status, 'stale-target');
  assert.equal(adapter.actCount, 0);
  assert.equal((await persistence.load(binding))?.actions[0]?.state, 'reconciled-not-dispatched');
});

test('saved reconciliation provenance cannot regress to anonymous not-started state', async () => {
  const { persistence, binding } = await fixture();
  const resolved = createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 1,
    actions: { write: 'reconciled-not-dispatched' },
  });
  await persistence.save(resolved, binding);

  const anonymous = createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 2,
    actions: { write: 'not-started' },
  });
  await assert.rejects(persistence.save(anonymous, binding), /reconciliation provenance regressed/);
  assert.equal((await persistence.load(binding))?.actions[0]?.state, 'reconciled-not-dispatched');
});
