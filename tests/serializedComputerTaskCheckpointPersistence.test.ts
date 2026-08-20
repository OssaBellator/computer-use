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
  id: 'serialized-persistence-test',
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

const BINDING = { program: PROGRAM, executionId: EXECUTION_ID };
const CHECKPOINT = createComputerTaskCheckpoint({
  program: PROGRAM,
  executionId: EXECUTION_ID,
  nextStepId: 'write',
  stepsExecuted: 0,
  actions: { write: 'not-started' },
});

class ControlledPersistence implements ComputerTaskCheckpointPersistence {
  readonly events: string[] = [];
  inFlight = 0;
  maxInFlight = 0;
  failNext = false;
  private releaseFirstSave?: () => void;
  readonly firstSaveStarted = new Promise<void>((resolve) => { this.markFirstSaveStarted = resolve; });
  private markFirstSaveStarted!: () => void;

  async load(_binding: ComputerTaskCheckpointPersistenceBinding): Promise<ComputerTaskCheckpoint | undefined> {
    this.enter('load');
    try {
      await Promise.resolve();
      return CHECKPOINT;
    } finally {
      this.leave('load');
    }
  }

  async save(_checkpoint: ComputerTaskCheckpoint, _binding: ComputerTaskCheckpointPersistenceBinding): Promise<void> {
    this.enter('save');
    const first = !this.releaseFirstSave;
    if (first) {
      await new Promise<void>((resolve) => {
        this.releaseFirstSave = resolve;
        this.markFirstSaveStarted();
      });
    }
    try {
      if (this.failNext) {
        this.failNext = false;
        throw new Error('planned persistence failure');
      }
      await Promise.resolve();
    } finally {
      this.leave('save');
    }
  }

  releaseFirst(): void {
    this.releaseFirstSave?.();
  }

  private enter(name: string): void {
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);
    this.events.push(`${name}:start`);
  }

  private leave(name: string): void {
    this.events.push(`${name}:end`);
    this.inFlight -= 1;
  }
}

test('shared wrapper serializes concurrent saves in call order', async () => {
  const inner = new ControlledPersistence();
  const persistence = new SerializedComputerTaskCheckpointPersistence(inner);

  const first = persistence.save(CHECKPOINT, BINDING);
  await inner.firstSaveStarted;
  const second = persistence.save(CHECKPOINT, BINDING);
  await Promise.resolve();

  assert.equal(inner.maxInFlight, 1);
  assert.deepEqual(inner.events, ['save:start']);

  inner.releaseFirst();
  await Promise.all([first, second]);
  assert.equal(inner.maxInFlight, 1);
  assert.deepEqual(inner.events, ['save:start', 'save:end', 'save:start', 'save:end']);
});

test('load cannot interleave with an in-flight save', async () => {
  const inner = new ControlledPersistence();
  const persistence = new SerializedComputerTaskCheckpointPersistence(inner);

  const save = persistence.save(CHECKPOINT, BINDING);
  await inner.firstSaveStarted;
  const load = persistence.load(BINDING);
  await Promise.resolve();
  assert.deepEqual(inner.events, ['save:start']);

  inner.releaseFirst();
  assert.equal(await load, CHECKPOINT);
  await save;
  assert.deepEqual(inner.events, ['save:start', 'save:end', 'load:start', 'load:end']);
});

test('failed operation does not poison later queued operations', async () => {
  const inner = new ControlledPersistence();
  const persistence = new SerializedComputerTaskCheckpointPersistence(inner);
  inner.failNext = true;

  const failed = persistence.save(CHECKPOINT, BINDING);
  await inner.firstSaveStarted;
  const later = persistence.load(BINDING);
  inner.releaseFirst();

  await assert.rejects(failed, /planned persistence failure/);
  assert.equal(await later, CHECKPOINT);
  assert.equal(inner.maxInFlight, 1);
});
