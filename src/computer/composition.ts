import type {
  ComputerActionRequest,
  ComputerActionResult,
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

/**
 * Small environment-neutral composition root for computer-use programs.
 *
 * Adapters remain peer capabilities and keep their own identity, observation,
 * action, approval, verification, and backend semantics. This helper only owns
 * neutral registration/routing and construction of the neutral task runtime.
 *
 * Task execution deliberately requires callers to retain the returned runtime:
 * checkpoint/reconciliation state is part of the no-replay safety boundary and
 * must not be hidden behind a stateless run convenience.
 */
export class ComputerRuntimeComposition {
  readonly registry: ComputerEnvironmentRegistry;

  constructor(adapters: readonly ComputerEnvironmentAdapter[] = []) {
    this.registry = new ComputerEnvironmentRegistry();
    for (const adapter of adapters) this.registry.register(adapter);
  }

  register(adapter: ComputerEnvironmentAdapter): this {
    this.registry.register(adapter);
    return this;
  }

  unregister(adapterId: string): boolean {
    return this.registry.unregister(adapterId);
  }

  descriptors(): ComputerEnvironmentAdapterDescriptor[] {
    return this.registry.descriptors();
  }

  observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    return this.registry.observe(request);
  }

  act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    return this.registry.act(request);
  }

  createTaskRuntime(
    program: ComputerTaskProgram,
    options: ComputerTaskRuntimeOptions,
  ): ComputerTaskRuntime {
    return new ComputerTaskRuntime(program, this.registry, options);
  }
}

export function createComputerRuntimeComposition(
  adapters: readonly ComputerEnvironmentAdapter[] = [],
): ComputerRuntimeComposition {
  return new ComputerRuntimeComposition(adapters);
}
