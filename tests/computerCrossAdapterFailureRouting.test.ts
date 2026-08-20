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
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '55555555555555555555555555555555';

class ResultAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  calls = 0;

  constructor(id: string, capability: string, private readonly result: ComputerActionResult) {
    this.descriptor = Object.freeze({
      id,
      kind: 'local-compute' as const,
      version: 'failure-routing-1',
      capabilities: Object.freeze([capability]),
    });
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
    this.calls += 1;
    return this.result;
  }
}

function task(primaryId: string, fallbackId: string): ComputerTaskProgram {
  return {
    id: 'cross-adapter-failure-routing',
    entry: 'primary',
    steps: [
      {
        kind: 'action',
        id: 'primary',
        request: {
          adapterId: primaryId,
          actionId: 'primary',
          capability: 'fixture.primary',
          effect: 'observe-only',
          idempotency: 'read-only',
        },
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

function environment(primary: ResultAdapter, fallback: ResultAdapter): ComputerEnvironmentRegistry {
  const registry = new ComputerEnvironmentRegistry();
  registry.register(primary);
  registry.register(fallback);
  return registry;
}

test('definite failed not-dispatched result may take explicit onFailure branch to another adapter', async () => {
  const primary = new ResultAdapter('primary:definite-failure', 'fixture.primary', {
    status: 'failed',
    dispatch: 'not-dispatched',
    verification: 'not-applicable',
    evidence: ['fixture-definite-failure'],
  });
  const fallback = new ResultAdapter('fallback:definite-failure', 'fixture.fallback', {
    status: 'completed',
    dispatch: 'not-dispatched',
    verification: 'verified',
    evidence: ['fixture-fallback-ok'],
  });

  const result = await new ComputerTaskRuntime(task(primary.descriptor.id, fallback.descriptor.id), environment(primary, fallback), {
    executionId: EXECUTION_ID,
  }).run();

  assert.equal(result.status, 'completed');
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 1);
});

test('unknown dispatch terminates before onFailure can invoke another adapter', async () => {
  const primary = new ResultAdapter('primary:unknown', 'fixture.primary', {
    status: 'unknown',
    dispatch: 'unknown',
    verification: 'unverified',
    evidence: ['fixture-unknown'],
  });
  const fallback = new ResultAdapter('fallback:unknown', 'fixture.fallback', {
    status: 'completed',
    dispatch: 'not-dispatched',
    verification: 'verified',
  });

  const result = await new ComputerTaskRuntime(task(primary.descriptor.id, fallback.descriptor.id), environment(primary, fallback), {
    executionId: EXECUTION_ID,
  }).run();

  assert.equal(result.status, 'unknown-dispatch');
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 0);
});

test('verification mismatch after dispatched-once terminates before onFailure branch', async () => {
  const primary = new ResultAdapter('primary:mismatch', 'fixture.primary', {
    status: 'failed',
    dispatch: 'dispatched-once',
    verification: 'mismatch',
    evidence: ['fixture-mismatch'],
  });
  const fallback = new ResultAdapter('fallback:mismatch', 'fixture.fallback', {
    status: 'completed',
    dispatch: 'not-dispatched',
    verification: 'verified',
  });

  const result = await new ComputerTaskRuntime(task(primary.descriptor.id, fallback.descriptor.id), environment(primary, fallback), {
    executionId: EXECUTION_ID,
  }).run();

  assert.equal(result.status, 'verification-mismatch');
  assert.equal(primary.calls, 1);
  assert.equal(fallback.calls, 0);
});

test('unsupported primary action does not treat onFailure as a generic fallback route', async () => {
  const primary = new ResultAdapter('primary:unsupported', 'different.capability', {
    status: 'completed',
    dispatch: 'not-dispatched',
    verification: 'verified',
  });
  const fallback = new ResultAdapter('fallback:unsupported', 'fixture.fallback', {
    status: 'completed',
    dispatch: 'not-dispatched',
    verification: 'verified',
  });

  const result = await new ComputerTaskRuntime(task(primary.descriptor.id, fallback.descriptor.id), environment(primary, fallback), {
    executionId: EXECUTION_ID,
  }).run();

  assert.equal(result.status, 'unsupported');
  assert.equal(primary.calls, 0);
  assert.equal(fallback.calls, 0);
});
