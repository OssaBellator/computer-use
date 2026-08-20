import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { createComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';

const task: ComputerTaskProgram = {
  id: 'checkpoint-history-review',
  entry: 'write',
  steps: [{
    kind: 'action',
    id: 'write',
    request: {
      adapterId: 'fake',
      actionId: 'write',
      capability: 'fake.write',
      effect: 'local-reversible',
      idempotency: 'idempotent',
    },
  }],
};

class CapabilityAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  actCount = 0;

  constructor(capabilities: readonly string[]) {
    this.descriptor = {
      id: 'fake',
      kind: 'desktop-ui' as const,
      version: '1',
      capabilities,
    };
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    return {
      adapterId: 'fake',
      environment: 'desktop-ui',
      channel: request.channel,
      sequence: 1,
      complete: true,
      truncated: false,
      data: { synthetic: true },
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actCount += 1;
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
  }
}

function registryWith(capabilities: readonly string[]): { registry: ComputerEnvironmentRegistry; adapter: CapabilityAdapter } {
  const registry = new ComputerEnvironmentRegistry();
  const adapter = new CapabilityAdapter(capabilities);
  registry.register(adapter);
  return { registry, adapter };
}

test('checkpoint rejects rollback-shaped entry action after execution advanced without a reachable history path', () => {
  assert.throws(
    () => createComputerTaskCheckpoint({
      program: task,
      executionId: EXECUTION_ID,
      nextStepId: 'write',
      stepsExecuted: 1,
      actions: { write: 'not-started' },
    }),
    /cursor\/action history is inconsistent/,
  );
});

test('observe then unstarted action remains a valid checkpoint after action preflight stops', async () => {
  const observeThenAction: ComputerTaskProgram = {
    id: 'checkpoint-observe-action-review',
    entry: 'read',
    steps: [
      {
        kind: 'observe',
        id: 'read',
        request: { adapterId: 'fake', channel: 'semantic-ui' },
        next: 'write',
      },
      {
        kind: 'action',
        id: 'write',
        request: {
          adapterId: 'fake',
          actionId: 'write',
          capability: 'fake.write',
          effect: 'local-reversible',
          idempotency: 'idempotent',
        },
      },
    ],
  };

  const first = registryWith([]);
  const runtime = new ComputerTaskRuntime(observeThenAction, first.registry, { executionId: EXECUTION_ID });
  const stopped = await runtime.run();
  assert.equal(stopped.status, 'unsupported');
  assert.equal(stopped.stepsExecuted, 1);
  assert.equal(stopped.nextStepId, 'write');
  assert.equal(first.adapter.actCount, 0);

  const checkpoint = runtime.checkpoint();
  assert.equal(checkpoint.actions.find((action) => action.stepId === 'write')?.state, 'not-started');

  const resumed = registryWith(['fake.write']);
  const result = await new ComputerTaskRuntime(observeThenAction, resumed.registry, {
    executionId: EXECUTION_ID,
    checkpoint,
  }).run();
  assert.equal(result.status, 'completed');
  assert.equal(resumed.adapter.actCount, 1);
});

test('zero-step checkpoint cannot move cursor away from program entry', () => {
  const twoStepTask: ComputerTaskProgram = {
    id: 'checkpoint-zero-step-review',
    entry: 'read',
    steps: [
      { kind: 'observe', id: 'read', request: { adapterId: 'fake', channel: 'semantic-ui' }, next: 'write' },
      task.steps[0]!,
    ],
  };
  assert.throws(
    () => createComputerTaskCheckpoint({
      program: twoStepTask,
      executionId: EXECUTION_ID,
      nextStepId: 'write',
      stepsExecuted: 0,
      actions: { write: 'not-started' },
    }),
    /zero-step cursor must remain at program entry/,
  );
});
