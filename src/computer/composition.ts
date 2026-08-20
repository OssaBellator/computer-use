import type {
  ComputerEnvironmentAdapter,
  ComputerEnvironmentAdapterDescriptor,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from './environmentAdapter.js';
import { ComputerEnvironmentRegistry } from './environmentRegistry.js';
import type { ComputerTaskProgram } from './computerTask.js';
import {
  ComputerTaskRuntime,
  type ComputerTaskRuntimeOptions,
} from './computerTaskRuntime.js';

function snapshotAdapter(
  adapter: ComputerEnvironmentAdapter,
  descriptor: ComputerEnvironmentAdapterDescriptor,
): ComputerEnvironmentAdapter {
  const observe = adapter.observe;
  const act = adapter.act;
  if (typeof observe !== 'function' || typeof act !== 'function') {
    throw new TypeError('computer environment adapter must implement observe() and act()');
  }
  return Object.freeze({
    descriptor,
    observe: observe.bind(adapter),
    act: act.bind(adapter),
  });
}

function validateAndSnapshotAdapter(adapter: ComputerEnvironmentAdapter): ComputerEnvironmentAdapter {
  const validationRegistry = new ComputerEnvironmentRegistry();
  validationRegistry.register(adapter);
  const [descriptor] = validationRegistry.descriptors();
  if (!descriptor) throw new Error('registered adapter descriptor unavailable');
  return snapshotAdapter(adapter, descriptor);
}

/**
 * Small environment-neutral composition root for computer-use programs.
 *
 * Adapters remain peer capabilities and keep their own identity, observation,
 * action, approval, verification, and backend semantics. This helper only owns
 * neutral registration/read-only observation and construction of the neutral
 * task runtime.
 *
 * Effectful actions deliberately do not have a direct composition convenience.
 * Callers should execute them through a retained ComputerTaskRuntime so approval,
 * generation revalidation, dispatch state, verification, and checkpoints remain
 * on the normal safety path. Advanced low-level routing remains available via
 * ComputerEnvironmentRegistry as a separate public contract.
 *
 * Task execution deliberately requires callers to retain the returned runtime:
 * checkpoint/reconciliation state is part of the no-replay safety boundary and
 * must not be hidden behind a stateless run convenience.
 *
 * Each runtime receives a registry snapshot of the adapters registered when the
 * runtime is constructed. Later composition mutations therefore cannot silently
 * rebind an in-flight task to another adapter instance with the same identity.
 */
export class ComputerRuntimeComposition {
  private readonly registry = new ComputerEnvironmentRegistry();
  private readonly runtimeAdapters = new Map<string, ComputerEnvironmentAdapter>();

  constructor(adapters: readonly ComputerEnvironmentAdapter[] = []) {
    for (const adapter of adapters) this.register(adapter);
  }

  register(adapter: ComputerEnvironmentAdapter): this {
    const snapshot = validateAndSnapshotAdapter(adapter);
    this.registry.register(snapshot);
    this.runtimeAdapters.set(snapshot.descriptor.id, snapshot);
    return this;
  }

  unregister(adapterId: string): boolean {
    const removed = this.registry.unregister(adapterId);
    if (removed) this.runtimeAdapters.delete(adapterId);
    return removed;
  }

  descriptors(): ComputerEnvironmentAdapterDescriptor[] {
    return this.registry.descriptors();
  }

  observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    return this.registry.observe(request);
  }

  createTaskRuntime(
    program: ComputerTaskProgram,
    options: ComputerTaskRuntimeOptions,
  ): ComputerTaskRuntime {
    const runtimeRegistry = new ComputerEnvironmentRegistry();
    for (const adapter of this.runtimeAdapters.values()) runtimeRegistry.register(adapter);
    return new ComputerTaskRuntime(program, runtimeRegistry, options);
  }
}

export function createComputerRuntimeComposition(
  adapters: readonly ComputerEnvironmentAdapter[] = [],
): ComputerRuntimeComposition {
  return new ComputerRuntimeComposition(adapters);
}
