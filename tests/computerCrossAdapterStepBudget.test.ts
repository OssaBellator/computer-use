import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import {
  COMPUTER_TASK_MAX_RETAINED_OBSERVATIONS,
  ComputerTaskRuntime,
} from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '12341234123412341234123412341234';

class BudgetAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  actions = 0;
  observations = 0;

  constructor(id: string) {
    this.descriptor = Object.freeze({
      id,
      kind: 'local-compute' as const,
      version: 'step-budget-1',
      capabilities: Object.freeze(['fixture.read']),
    });
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    this.observations += 1;
    return {
      adapterId: this.descriptor.id,
      environment: this.descriptor.kind,
      channel: request.channel,
      sequence: this.observations,
      complete: true,
      truncated: false,
      data: { privateCycleValue: `${this.descriptor.id}:${this.observations}` },
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actions += 1;
    return {
      status: 'completed',
      dispatch: 'not-dispatched',
      verification: 'verified',
      evidence: ['budget-action-ok'],
    };
  }
}

function registry(...adapters: ComputerEnvironmentAdapter[]): ComputerEnvironmentRegistry {
  const value = new ComputerEnvironmentRegistry();
  for (const adapter of adapters) value.register(adapter);
  return value;
}

test('cyclic observation task across ten adapters exhausts the step budget while retention remains bounded', async () => {
  const adapters = Array.from({ length: 10 }, (_, index) => new BudgetAdapter(`compute:cycle-observe-${index}`));
  const task: ComputerTaskProgram = {
    id: 'cross-adapter-observation-cycle-budget',
    entry: 'observe-0',
    steps: adapters.map((adapter, index) => ({
      kind: 'observe' as const,
      id: `observe-${index}`,
      request: { adapterId: adapter.descriptor.id, channel: 'compute' as const },
      next: `observe-${(index + 1) % adapters.length}`,
    })),
  };

  const result = await new ComputerTaskRuntime(task, registry(...adapters), { executionId: EXECUTION_ID }).run();

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.evidence, ['task-step-budget-exhausted']);
  assert.equal(adapters.reduce((sum, adapter) => sum + adapter.observations, 0), 70);
  assert.equal(result.observations.length, COMPUTER_TASK_MAX_RETAINED_OBSERVATIONS);
  assert.equal(result.observationsDropped, 70 - COMPUTER_TASK_MAX_RETAINED_OBSERVATIONS);
  assert.equal(JSON.stringify(result).includes('privateCycleValue'), false);
});

test('cyclic completed actions across adapters are each dispatched once, then skipped until the step budget terminates the loop', async () => {
  const left = new BudgetAdapter('compute:cycle-action-left');
  const right = new BudgetAdapter('compute:cycle-action-right');
  const task: ComputerTaskProgram = {
    id: 'cross-adapter-action-cycle-budget',
    entry: 'left',
    steps: [
      {
        kind: 'action',
        id: 'left',
        request: {
          adapterId: left.descriptor.id,
          actionId: 'left',
          capability: 'fixture.read',
          effect: 'observe-only',
          idempotency: 'read-only',
        },
        onSuccess: 'right',
      },
      {
        kind: 'action',
        id: 'right',
        request: {
          adapterId: right.descriptor.id,
          actionId: 'right',
          capability: 'fixture.read',
          effect: 'observe-only',
          idempotency: 'read-only',
        },
        onSuccess: 'left',
      },
    ],
  };

  const result = await new ComputerTaskRuntime(task, registry(left, right), { executionId: EXECUTION_ID }).run();

  assert.equal(result.status, 'failed');
  assert.deepEqual(result.evidence, ['task-step-budget-exhausted']);
  assert.equal(result.stepsExecuted, 2);
  assert.equal(left.actions, 1);
  assert.equal(right.actions, 1);
});
