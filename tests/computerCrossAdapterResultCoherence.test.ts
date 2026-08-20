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

const EXECUTION_ID = 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

class ResultAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  actions = 0;

  constructor(id: string, capability: string, private readonly result: ComputerActionResult) {
    this.descriptor = Object.freeze({
      id,
      kind: 'local-compute' as const,
      version: 'result-coherence-1',
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
    this.actions += 1;
    return this.result;
  }
}

function registry(...adapters: ComputerEnvironmentAdapter[]): ComputerEnvironmentRegistry {
  const value = new ComputerEnvironmentRegistry();
  for (const adapter of adapters) value.register(adapter);
  return value;
}

function program(sourceId: string, fallbackId: string): ComputerTaskProgram {
  return {
    id: `result-coherence-${sourceId}`,
    entry: 'source',
    steps: [
      {
        kind: 'action',
        id: 'source',
        request: {
          adapterId: sourceId,
          actionId: 'source',
          capability: 'fixture.source',
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

const fallbackSuccess: ComputerActionResult = {
  status: 'completed',
  dispatch: 'not-dispatched',
  verification: 'verified',
  evidence: ['fallback-ok'],
};

for (const fixture of [
  {
    name: 'completed plus unknown dispatch',
    result: { status: 'completed', dispatch: 'unknown', verification: 'verified' },
  },
  {
    name: 'failed plus verified',
    result: { status: 'failed', dispatch: 'not-dispatched', verification: 'verified' },
  },
  {
    name: 'completed plus pending verification',
    result: { status: 'completed', dispatch: 'dispatched-once', verification: 'pending' },
  },
  {
    name: 'pending verification plus definite non-dispatch',
    result: { status: 'failed', dispatch: 'not-dispatched', verification: 'pending' },
  },
] as const) {
  test(`incoherent ${fixture.name} is normalized to unknown and cannot retry or cross to fallback`, async () => {
    const source = new ResultAdapter(
      `compute:coherence-${fixture.name.replaceAll(' ', '-')}`,
      'fixture.source',
      fixture.result as ComputerActionResult,
    );
    const fallback = new ResultAdapter('compute:coherence-fallback', 'fixture.fallback', fallbackSuccess);

    const result = await new ComputerTaskRuntime(
      program(source.descriptor.id, fallback.descriptor.id),
      registry(source, fallback),
      { executionId: EXECUTION_ID },
    ).run();

    assert.equal(result.status, 'unknown-dispatch');
    assert.deepEqual(result.evidence, ['adapter-response-invalid']);
    assert.equal(source.actions, 1);
    assert.equal(fallback.actions, 0);
  });
}

test('valid definite non-dispatch failure keeps its safe retry semantics instead of being normalized', async () => {
  const source = new ResultAdapter('compute:coherence-valid-failure', 'fixture.source', {
    status: 'failed',
    dispatch: 'not-dispatched',
    verification: 'unverified',
    evidence: ['valid-definite-failure'],
  });
  const fallback = new ResultAdapter('compute:coherence-valid-fallback', 'fixture.fallback', fallbackSuccess);

  const result = await new ComputerTaskRuntime(
    program(source.descriptor.id, fallback.descriptor.id),
    registry(source, fallback),
    { executionId: EXECUTION_ID },
  ).run();

  assert.equal(result.status, 'completed');
  assert.equal(source.actions, 4);
  assert.equal(fallback.actions, 1);
});
