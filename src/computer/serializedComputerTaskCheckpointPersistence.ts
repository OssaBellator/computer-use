import { snapshotComputerTaskProgram } from './computerTask.js';
import {
  decodeComputerTaskCheckpoint,
  encodeComputerTaskCheckpoint,
  type ComputerTaskCheckpoint,
} from './computerTaskCheckpoint.js';
import type {
  ComputerTaskCheckpointPersistence,
  ComputerTaskCheckpointPersistenceBinding,
} from './computerTaskCheckpointPersistence.js';

function snapshotBinding(binding: ComputerTaskCheckpointPersistenceBinding): ComputerTaskCheckpointPersistenceBinding {
  return Object.freeze({
    program: snapshotComputerTaskProgram(binding.program),
    executionId: binding.executionId,
  });
}

function snapshotCheckpoint(checkpoint: ComputerTaskCheckpoint): ComputerTaskCheckpoint {
  return decodeComputerTaskCheckpoint(encodeComputerTaskCheckpoint(checkpoint));
}

/**
 * Storage-neutral process-local serialization for checkpoint persistence.
 *
 * This wrapper does not add authenticity, rollback detection, or cross-process locking.
 * It only guarantees that callers sharing this wrapper cannot interleave load/save
 * operations against an underlying persistence implementation. Caller-owned arguments
 * are snapshotted synchronously before the queue await boundary.
 */
export class SerializedComputerTaskCheckpointPersistence implements ComputerTaskCheckpointPersistence {
  private tail: Promise<void> = Promise.resolve();

  constructor(private readonly inner: ComputerTaskCheckpointPersistence) {}

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    return previous.then(operation).finally(release);
  }

  load(binding: ComputerTaskCheckpointPersistenceBinding): Promise<ComputerTaskCheckpoint | undefined> {
    const bindingSnapshot = snapshotBinding(binding);
    return this.enqueue(() => this.inner.load(bindingSnapshot));
  }

  save(
    checkpoint: ComputerTaskCheckpoint,
    binding: ComputerTaskCheckpointPersistenceBinding,
  ): Promise<void> {
    const checkpointSnapshot = snapshotCheckpoint(checkpoint);
    const bindingSnapshot = snapshotBinding(binding);
    return this.enqueue(() => this.inner.save(checkpointSnapshot, bindingSnapshot));
  }
}
