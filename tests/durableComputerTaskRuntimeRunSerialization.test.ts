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
  id: 'durable-run-serialization-test',
  entry: 'write',
  steps: [{
    kind: 'action', id: 'write',
    request: { adapterId: 'fake', actionId: 'write', capability: 'fake.write', effect: 'local-reversible', idempotency: 'non-idempotent' },
  }],
};

class BlockingAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor = { id: 'fake', kind: 'desktop-ui' as const, version: '1', capabilities: ['fake.write'] };
  actCount = 0;
  private release!: () => void;
  private started!: () => void;
  readonly startedPromise = new Promise<void>((resolve) => { this.started = resolve; });
  private readonly releasePromise = new Promise<void>((resolve) => { this.release = resolve; });

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    return { adapterId: 'fake', environment: 'desktop-ui', channel: request.channel, sequence: 1, complete: true, truncated: false, data: undefined };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actCount += 1;
    this.started();
    await this.releasePromise;
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
  }

  finish(): void { this.release(); }
}

test('concurrent run calls serialize and dispatch a completed action only once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'durable-run-serialization-'));
  const persistence = new LocalFileComputerTaskCheckpointPersistence({
    filePath: join(directory, 'checkpoint.json'), authenticationKey: KEY,
  });
  const adapter = new BlockingAdapter();
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);
  const runtime = await DurableComputerTaskRuntime.create(PROGRAM, registry, persistence, { executionId: EXECUTION_ID });

  const first = runtime.run();
  await adapter.startedPromise;
  const second = runtime.run();
  await Promise.resolve();
  assert.equal(adapter.actCount, 1, 'second run must remain queued while first dispatch is in flight');

  adapter.finish();
  assert.equal((await first).status, 'completed');
  assert.equal((await second).status, 'completed');
  assert.equal(adapter.actCount, 1);
});
