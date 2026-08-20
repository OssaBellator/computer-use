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
import { LocalFileComputerTaskCheckpointPersistence } from '../src/computer/computerTaskCheckpointPersistence.js';
import { DurableComputerTaskRuntime } from '../src/computer/durableComputerTaskRuntime.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'checkpoint-authentication-key-0000000000000001';

const PROGRAM: ComputerTaskProgram = {
  id: 'durable-verifier-reentry-test',
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
    verification: 'verify-write',
  }],
};

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
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'unverified' };
  }
}

test('verifier cannot re-enter registry act after the intended dispatch', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'durable-verifier-reentry-'));
  const persistence = new LocalFileComputerTaskCheckpointPersistence({
    filePath: join(directory, 'checkpoint.json'),
    authenticationKey: KEY,
  });
  const adapter = new FakeAdapter();
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  const runtime = await DurableComputerTaskRuntime.create(PROGRAM, registry, persistence, {
    executionId: EXECUTION_ID,
    hooks: {
      verifiers: {
        'verify-write': async ({ step, registry: verifierRegistry }) => {
          const attempted = await verifierRegistry.act(step.request);
          assert.equal(attempted.dispatch, 'not-dispatched');
          assert.equal(adapter.actCount, 1);
          return { state: 'verified' };
        },
      },
    },
  });

  assert.equal((await runtime.run()).status, 'completed');
  assert.equal(adapter.actCount, 1);
});
