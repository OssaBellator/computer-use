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
  id: 'durable-operation-isolation-test',
  entry: 'write',
  steps: [{
    kind: 'action', id: 'write',
    request: { adapterId: 'fake', actionId: 'write', capability: 'fake.write', effect: 'local-reversible', idempotency: 'non-idempotent' },
  }],
};

class BlockingAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor = { id: 'fake', kind: 'desktop-ui' as const, version: '1', capabilities: ['fake.write'] };
  actCount = 0;
  private started!: () => void;
  private finishAct!: () => void;
  readonly startedPromise = new Promise<void>((resolve) => { this.started = resolve; });
  private readonly finishPromise = new Promise<void>((resolve) => { this.finishAct = resolve; });

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    return { adapterId: 'fake', environment: 'desktop-ui', channel: request.channel, sequence: 1, complete: true, truncated: false, data: undefined };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actCount += 1;
    this.started();
    await this.finishPromise;
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
  }

  finish(): void { this.finishAct(); }
}

test('manual checkpoint persistence cannot overwrite write-ahead uncertainty while dispatch is in flight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'durable-operation-isolation-'));
  const persistence = new LocalFileComputerTaskCheckpointPersistence({
    filePath: join(directory, 'checkpoint.json'), authenticationKey: KEY,
  });
  const binding = { program: PROGRAM, executionId: EXECUTION_ID };
  const adapter = new BlockingAdapter();
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);
  const runtime = await DurableComputerTaskRuntime.create(PROGRAM, registry, persistence, { executionId: EXECUTION_ID });

  const running = runtime.run();
  await adapter.startedPromise;
  const writeAhead = await persistence.load(binding);
  assert.equal(writeAhead?.actions[0]?.state, 'unknown-dispatch');

  const queuedPersistence = runtime.persistCheckpoint();
  await Promise.resolve();
  assert.equal((await persistence.load(binding))?.actions[0]?.state, 'unknown-dispatch');
  assert.throws(() => runtime.checkpoint(), /operation is pending/);
  assert.throws(() => runtime.pendingReconciliations(), /operation is pending/);
  assert.throws(() => runtime.resolveReconciliation('write', 'completed'), /operation is pending/);

  adapter.finish();
  assert.equal((await running).status, 'completed');
  await queuedPersistence;
  assert.equal((await persistence.load(binding))?.actions[0]?.state, 'completed');
  assert.equal(adapter.actCount, 1);
});
