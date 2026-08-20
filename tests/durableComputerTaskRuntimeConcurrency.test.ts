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
import { createComputerTaskCheckpoint, type ComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';
import {
  LocalFileComputerTaskCheckpointPersistence,
  type ComputerTaskCheckpointPersistence,
  type ComputerTaskCheckpointPersistenceBinding,
} from '../src/computer/computerTaskCheckpointPersistence.js';
import { DurableComputerTaskRuntime } from '../src/computer/durableComputerTaskRuntime.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'checkpoint-authentication-key-0000000000000001';

const PROGRAM: ComputerTaskProgram = {
  id: 'durable-concurrency-test',
  entry: 'write',
  steps: [{
    kind: 'action', id: 'write',
    request: { adapterId: 'fake', actionId: 'write', capability: 'fake.write', effect: 'local-reversible', idempotency: 'non-idempotent' },
  }],
};

class FakeAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor = { id: 'fake', kind: 'desktop-ui' as const, version: '1', capabilities: ['fake.write'] };
  actCount = 0;
  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    return { adapterId: 'fake', environment: 'desktop-ui', channel: request.channel, sequence: 1, complete: true, truncated: false, data: undefined };
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

async function localPersistence() {
  const directory = await mkdtemp(join(tmpdir(), 'durable-concurrency-'));
  return new LocalFileComputerTaskCheckpointPersistence({ filePath: join(directory, 'checkpoint.json'), authenticationKey: KEY });
}

class AlwaysFailSavePersistence implements ComputerTaskCheckpointPersistence {
  constructor(readonly inner: ComputerTaskCheckpointPersistence) {}
  load(binding: ComputerTaskCheckpointPersistenceBinding): Promise<ComputerTaskCheckpoint | undefined> { return this.inner.load(binding); }
  save(_checkpoint: ComputerTaskCheckpoint, _binding: ComputerTaskCheckpointPersistenceBinding): Promise<void> {
    return Promise.reject(new Error('planned save failure'));
  }
}

test('checkpoint refresh failure does not downgrade an existing reconciliation-required result', async () => {
  const persistence = await localPersistence();
  const binding = { program: PROGRAM, executionId: EXECUTION_ID };
  await persistence.save(createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 1,
    actions: { write: 'unknown-dispatch' },
  }), binding);

  const env = environment();
  const runtime = await DurableComputerTaskRuntime.create(PROGRAM, env.registry, new AlwaysFailSavePersistence(persistence), { executionId: EXECUTION_ID });
  const result = await runtime.run();
  assert.equal(result.status, 'reconciliation-required');
  assert.ok(result.evidence?.includes('checkpoint-persist-failed'));
  assert.equal(env.adapter.actCount, 0);
});

test('overlapping reconciliation assessments keep dispatch blocked until all assessments exit', async () => {
  const persistence = await localPersistence();
  await persistence.save(createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 1,
    actions: { write: 'unknown-dispatch' },
  }), { program: PROGRAM, executionId: EXECUTION_ID });

  const env = environment();
  let calls = 0;
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  let firstStarted!: () => void;
  let secondStarted!: () => void;
  const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
  const secondStartedPromise = new Promise<void>((resolve) => { secondStarted = resolve; });
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const secondRelease = new Promise<void>((resolve) => { releaseSecond = resolve; });

  const runtime = await DurableComputerTaskRuntime.create(PROGRAM, env.registry, persistence, {
    executionId: EXECUTION_ID,
    hooks: {
      reconcile: async ({ step, registry }) => {
        calls += 1;
        const call = calls;
        if (call === 1) {
          firstStarted();
          await firstRelease;
          return { outcome: 'uncertain' };
        }
        secondStarted();
        await secondRelease;
        const attempted = await registry.act(step.request);
        assert.equal(attempted.status, 'rejected');
        assert.ok(attempted.evidence?.includes('reconciliation-dispatch-blocked'));
        return { outcome: 'uncertain' };
      },
    },
  });

  const first = runtime.assessReconciliation('write');
  await firstStartedPromise;
  const second = runtime.assessReconciliation('write');
  await secondStartedPromise;
  releaseFirst();
  await first;
  releaseSecond();
  await second;

  assert.equal(env.adapter.actCount, 0);
});
