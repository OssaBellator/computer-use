import type { ComputerTaskCheckpoint } from './computerTaskCheckpoint.js';
import type {
  ComputerTaskCheckpointPersistence,
  ComputerTaskCheckpointPersistenceBinding,
} from './computerTaskCheckpointPersistence.js';

/**
 * Storage-neutral process-local serialization for checkpoint persistence.
 *
 * This wrapper does not add authenticity, rollback detection, or cross-process locking.
 * It only guarantees that callers sharing this wrapper cannot interleave load/save
 * operations against an underlying persistence implementation.
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
    return this.enqueue(() => this.inner.load(binding));
  }

  save(
    checkpoint: ComputerTaskCheckpoint,
    binding: ComputerTaskCheckpointPersistenceBinding,
  ): Promise<void> {
    return this.enqueue(() => this.inner.save(checkpoint, binding));
  }
}
