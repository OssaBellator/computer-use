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
  ComputerVerificationState,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { LocalFileComputerTaskCheckpointPersistence } from '../src/computer/computerTaskCheckpointPersistence.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';
const KEY = 'checkpoint-authentication-key-0000000000000001';

function task(): ComputerTaskProgram {
  return {
    id: 'verifier-reconciliation-persistence-test',
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
      verification: 'domain.verify',
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

async function persistRuntimeCheckpoint(runtime: ComputerTaskRuntime, program: ComputerTaskProgram) {
  const directory = await mkdtemp(join(tmpdir(), 'computer-verifier-reconcile-'));
  const persistence = new LocalFileComputerTaskCheckpointPersistence({
    filePath: join(directory, 'checkpoint.json'),
    authenticationKey: KEY,
  });
  const binding = { program, executionId: EXECUTION_ID };
  await persistence.save(runtime.checkpoint(), binding);
  return persistence.load(binding);
}

for (const [verification, expectedStatus, expectedReconciliation] of [
  ['pending', 'verification-pending', 'verification-pending'],
  ['mismatch', 'verification-mismatch', 'verification-mismatch'],
] as const satisfies readonly [ComputerVerificationState, string, string][]) {
  test(`${verification} verifier state survives authenticated restart as explicit reconciliation`, async () => {
    const program = task();
    const first = environment();
    const runtime = new ComputerTaskRuntime(program, first.registry, {
      executionId: EXECUTION_ID,
      hooks: {
        verifiers: {
          'domain.verify': async () => ({ state: verification }),
        },
      },
    });

    const stopped = await runtime.run();
    assert.equal(stopped.status, expectedStatus);
    assert.equal(first.adapter.actCount, 1);

    const loaded = await persistRuntimeCheckpoint(runtime, program);
    assert.ok(loaded);
    const restarted = environment();
    const resumed = new ComputerTaskRuntime(program, restarted.registry, {
      executionId: EXECUTION_ID,
      checkpoint: loaded,
    });

    assert.deepEqual(resumed.pendingReconciliations(), [{
      stepId: 'write',
      state: expectedReconciliation,
    }]);
    assert.equal((await resumed.run()).status, 'reconciliation-required');
    assert.equal(restarted.adapter.actCount, 0);
  });
}
