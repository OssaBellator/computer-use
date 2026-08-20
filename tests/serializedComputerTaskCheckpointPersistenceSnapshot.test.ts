import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { createComputerTaskCheckpoint, type ComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';
import type {
  ComputerTaskCheckpointPersistence,
  ComputerTaskCheckpointPersistenceBinding,
} from '../src/computer/computerTaskCheckpointPersistence.js';
import { SerializedComputerTaskCheckpointPersistence } from '../src/computer/serializedComputerTaskCheckpointPersistence.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';

const PROGRAM: ComputerTaskProgram = {
  id: 'serializer-snapshot-test',
  entry: 'write',
  steps: [{
    kind: 'action', id: 'write',
    request: { adapterId: 'fake', actionId: 'write', capability: 'fake.write', effect: 'local-reversible', idempotency: 'non-idempotent' },
  }],
};

class BlockingPersistence implements ComputerTaskCheckpointPersistence {
  seenCheckpoint?: ComputerTaskCheckpoint;
  seenBinding?: ComputerTaskCheckpointPersistenceBinding;
  private releaseFirst!: () => void;
  readonly firstStarted: Promise<void>;
  private markFirstStarted!: () => void;

  constructor() {
    this.firstStarted = new Promise<void>((resolve) => { this.markFirstStarted = resolve; });
  }

  async load(_binding: ComputerTaskCheckpointPersistenceBinding): Promise<ComputerTaskCheckpoint | undefined> {
    this.markFirstStarted();
    await new Promise<void>((resolve) => { this.releaseFirst = resolve; });
    return undefined;
  }

  async save(checkpoint: ComputerTaskCheckpoint, binding: ComputerTaskCheckpointPersistenceBinding): Promise<void> {
    this.seenCheckpoint = checkpoint;
    this.seenBinding = binding;
  }

  release(): void { this.releaseFirst(); }
}

test('queued save snapshots checkpoint and binding before the await boundary', async () => {
  const inner = new BlockingPersistence();
  const persistence = new SerializedComputerTaskCheckpointPersistence(inner);
  const blocker = persistence.load({ program: PROGRAM, executionId: EXECUTION_ID });
  await inner.firstStarted;

  const mutableCheckpoint = JSON.parse(JSON.stringify(createComputerTaskCheckpoint({
    program: PROGRAM,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 0,
    actions: { write: 'not-started' },
  }))) as ComputerTaskCheckpoint;
  const mutableProgram = JSON.parse(JSON.stringify(PROGRAM)) as ComputerTaskProgram;
  const mutableBinding = { program: mutableProgram, executionId: EXECUTION_ID };

  const queued = persistence.save(mutableCheckpoint, mutableBinding);
  (mutableCheckpoint.actions[0] as { state: string }).state = 'completed';
  mutableProgram.id = 'mutated-after-enqueue';
  mutableBinding.executionId = 'ffffffffffffffffffffffffffffffff';

  inner.release();
  await blocker;
  await queued;

  assert.equal(inner.seenCheckpoint?.actions[0]?.state, 'not-started');
  assert.equal(inner.seenBinding?.program.id, 'serializer-snapshot-test');
  assert.equal(inner.seenBinding?.executionId, EXECUTION_ID);
});
