import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerEnvironmentKind,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '88888888888888888888888888888888';

class ExceptionAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  actions = 0;
  observations = 0;

  constructor(
    id: string,
    kind: ComputerEnvironmentKind,
    capabilities: readonly string[],
    private readonly behavior: 'complete' | 'throw-action' | 'reject-action' | 'throw-observe' = 'complete',
  ) {
    this.descriptor = Object.freeze({ id, kind, version: 'exception-boundary-1', capabilities: Object.freeze([...capabilities]) });
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    this.observations += 1;
    if (this.behavior === 'throw-observe') throw new Error('private-observation-failure');
    return {
      adapterId: this.descriptor.id,
      environment: this.descriptor.kind,
      channel: request.channel,
      sequence: this.observations,
      complete: true,
      truncated: false,
      data: null,
    };
  }

  act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actions += 1;
    if (this.behavior === 'throw-action') throw new Error('private-action-failure');
    if (this.behavior === 'reject-action') return Promise.reject(new Error('private-async-action-failure'));
    return Promise.resolve({
      status: 'completed',
      dispatch: 'not-dispatched',
      verification: 'verified',
      evidence: ['exception-fixture-ok'],
    });
  }
}

function registry(...adapters: ComputerEnvironmentAdapter[]): ComputerEnvironmentRegistry {
  const value = new ComputerEnvironmentRegistry();
  for (const adapter of adapters) value.register(adapter);
  return value;
}

function throwingActionProgram(adapterId: string, fallbackId: string): ComputerTaskProgram {
  return {
    id: `adapter-exception-${adapterId}`,
    entry: 'dangerous',
    steps: [
      {
        kind: 'action',
        id: 'dangerous',
        request: {
          adapterId,
          actionId: 'dangerous',
          capability: 'fixture.execute',
          effect: 'local-reversible',
          idempotency: 'idempotent',
        },
        maxRetries: 3,
        onFailure: 'fallback',
      },
      {
        kind: 'action',
        id: 'fallback',
        request: {
          adapterId: fallbackId,
          actionId: 'fallback',
          capability: 'fixture.fallback',
          effect: 'observe-only',
          idempotency: 'read-only',
        },
      },
    ],
  };
}

test('synchronous action throw becomes unknown dispatch, is not retried, and cannot route to fallback adapter', async () => {
  const throwing = new ExceptionAdapter('compute:throw-sync', 'local-compute', ['fixture.execute'], 'throw-action');
  const fallback = new ExceptionAdapter('compute:fallback-sync', 'local-compute', ['fixture.fallback']);

  const result = await new ComputerTaskRuntime(
    throwingActionProgram(throwing.descriptor.id, fallback.descriptor.id),
    registry(throwing, fallback),
    {
      executionId: EXECUTION_ID,
      hooks: { approve: async () => true },
    },
  ).run();

  assert.equal(result.status, 'unknown-dispatch');
  assert.deepEqual(result.evidence, ['adapter-threw-after-invocation']);
  assert.equal(throwing.actions, 1);
  assert.equal(fallback.actions, 0);
  assert.equal(JSON.stringify(result).includes('private-action-failure'), false);
});

test('asynchronous action rejection has the same unknown non-retryable cross-adapter semantics', async () => {
  const rejecting = new ExceptionAdapter('compute:throw-async', 'local-compute', ['fixture.execute'], 'reject-action');
  const fallback = new ExceptionAdapter('compute:fallback-async', 'local-compute', ['fixture.fallback']);

  const result = await new ComputerTaskRuntime(
    throwingActionProgram(rejecting.descriptor.id, fallback.descriptor.id),
    registry(rejecting, fallback),
    {
      executionId: EXECUTION_ID,
      hooks: { approve: async () => true },
    },
  ).run();

  assert.equal(result.status, 'unknown-dispatch');
  assert.deepEqual(result.evidence, ['adapter-threw-after-invocation']);
  assert.equal(rejecting.actions, 1);
  assert.equal(fallback.actions, 0);
  assert.equal(JSON.stringify(result).includes('private-async-action-failure'), false);
});

test('observation throw rejects the run before any later effectful adapter is invoked', async () => {
  const observing = new ExceptionAdapter('browser:throw-observe', 'browser', ['browser.observe'], 'throw-observe');
  const terminal = new ExceptionAdapter('terminal:after-observe', 'terminal', ['fixture.execute']);
  const program: ComputerTaskProgram = {
    id: 'adapter-observation-exception-boundary',
    entry: 'observe',
    steps: [
      {
        kind: 'observe',
        id: 'observe',
        request: { adapterId: observing.descriptor.id, channel: 'semantic-ui' },
        next: 'execute',
      },
      {
        kind: 'action',
        id: 'execute',
        request: {
          adapterId: terminal.descriptor.id,
          actionId: 'execute',
          capability: 'fixture.execute',
          effect: 'process-execution',
          idempotency: 'non-idempotent',
        },
      },
    ],
  };

  await assert.rejects(
    new ComputerTaskRuntime(program, registry(observing, terminal), {
      executionId: EXECUTION_ID,
      hooks: { approve: async () => true },
    }).run(),
    /private-observation-failure/,
  );

  assert.equal(observing.observations, 1);
  assert.equal(terminal.actions, 0);
});
