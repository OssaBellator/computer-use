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
  decodeComputerTaskCheckpoint,
  encodeComputerTaskCheckpoint,
} from '../src/computer/computerTaskCheckpoint.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

class ActionAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  actions = 0;

  constructor(
    id: string,
    capabilities: readonly string[],
    private readonly result: ComputerActionResult,
  ) {
    this.descriptor = Object.freeze({ id, kind: 'local-compute' as const, version: 'failure-checkpoint-1', capabilities: Object.freeze([...capabilities]) });
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    return {
      adapterId: this.descriptor.id,
      environment: this.descriptor.kind,
      channel: request.channel,
      sequence: 1,
      complete: true,
      truncated: false,
      data: null,
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actions += 1;
    return this.result;
  }
}

function registry(...adapters: ComputerEnvironmentAdapter[]): ComputerEnvironmentRegistry {
  const value = new ComputerEnvironmentRegistry();
  for (const adapter of adapters) value.register(adapter);
  return value;
}

function program(primaryId: string, fallbackId: string, maxRetries = 0): ComputerTaskProgram {
  return {
    id: `definite-failure-checkpoint-${maxRetries}`,
    entry: 'primary',
    steps: [
      {
        kind: 'action',
        id: 'primary',
        request: {
          adapterId: primaryId,
          actionId: 'primary',
          capability: 'fixture.primary',
          effect: 'local-reversible',
          idempotency: 'idempotent',
        },
        maxRetries,
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

const definiteFailure: ComputerActionResult = {
  status: 'failed',
  dispatch: 'not-dispatched',
  verification: 'unverified',
  evidence: ['definite-pre-dispatch-failure'],
};

const success: ComputerActionResult = {
  status: 'completed',
  dispatch: 'not-dispatched',
  verification: 'verified',
  evidence: ['fallback-ok'],
};

test('portable checkpoint at a missing fallback resumes there without replaying the definite failed source action', async () => {
  const primary = new ActionAdapter('compute:failure-source', ['fixture.primary'], definiteFailure);
  const fallbackId = 'compute:failure-fallback';
  const task = program(primary.descriptor.id, fallbackId);

  const firstRuntime = new ComputerTaskRuntime(task, registry(primary), {
    executionId: EXECUTION_ID,
    hooks: { approve: async () => true },
  });
  const stopped = await firstRuntime.run();

  assert.equal(stopped.status, 'unsupported');
  assert.equal(stopped.nextStepId, 'fallback');
  assert.equal(stopped.stepsExecuted, 1);
  assert.ok(stopped.evidence?.includes('adapter-not-found'));
  assert.equal(primary.actions, 1);

  const checkpoint = decodeComputerTaskCheckpoint(encodeComputerTaskCheckpoint(firstRuntime.checkpoint()));
  const replacementPrimary = new ActionAdapter('compute:failure-source', ['fixture.primary'], success);
  const fallback = new ActionAdapter(fallbackId, ['fixture.fallback'], success);
  const resumed = await new ComputerTaskRuntime(task, registry(replacementPrimary, fallback), {
    executionId: EXECUTION_ID,
    checkpoint,
    hooks: { approve: async () => true },
  }).run();

  assert.equal(resumed.status, 'completed');
  assert.equal(replacementPrimary.actions, 0);
  assert.equal(fallback.actions, 1);
});

test('completed definite-not-dispatched retries are not repeated after the task crosses to a checkpointed fallback adapter', async () => {
  const primary = new ActionAdapter('compute:retry-source', ['fixture.primary'], definiteFailure);
  const fallbackId = 'compute:retry-fallback';
  const task = program(primary.descriptor.id, fallbackId, 1);

  const firstRuntime = new ComputerTaskRuntime(task, registry(primary), {
    executionId: EXECUTION_ID,
    hooks: { approve: async () => true },
  });
  const stopped = await firstRuntime.run();

  assert.equal(stopped.status, 'unsupported');
  assert.equal(stopped.nextStepId, 'fallback');
  assert.equal(primary.actions, 2);

  const checkpoint = decodeComputerTaskCheckpoint(encodeComputerTaskCheckpoint(firstRuntime.checkpoint()));
  const replacementPrimary = new ActionAdapter('compute:retry-source', ['fixture.primary'], success);
  const fallback = new ActionAdapter(fallbackId, ['fixture.fallback'], success);
  const resumed = await new ComputerTaskRuntime(task, registry(replacementPrimary, fallback), {
    executionId: EXECUTION_ID,
    checkpoint,
    hooks: { approve: async () => true },
  }).run();

  assert.equal(resumed.status, 'completed');
  assert.equal(replacementPrimary.actions, 0);
  assert.equal(fallback.actions, 1);
});
