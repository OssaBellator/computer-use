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

const EXECUTION_ID = '13571357135713571357135713571357';

class SequenceAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  actions = 0;

  constructor(id: string, capability: string, private readonly results: readonly ComputerActionResult[]) {
    this.descriptor = Object.freeze({
      id,
      kind: 'local-compute' as const,
      version: 'readonly-retry-1',
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
    const index = this.actions;
    this.actions += 1;
    return this.results[Math.min(index, this.results.length - 1)]!;
  }
}

function registry(...adapters: ComputerEnvironmentAdapter[]): ComputerEnvironmentRegistry {
  const value = new ComputerEnvironmentRegistry();
  for (const adapter of adapters) value.register(adapter);
  return value;
}

function task(sourceId: string, fallbackId?: string, maxRetries = 1): ComputerTaskProgram {
  const steps: ComputerTaskProgram['steps'] = [
    {
      kind: 'action',
      id: 'read',
      request: {
        adapterId: sourceId,
        actionId: 'read',
        capability: 'fixture.read',
        effect: 'observe-only',
        idempotency: 'read-only',
      },
      maxRetries,
      onFailure: fallbackId ? 'fallback' : undefined,
    },
  ];
  if (fallbackId) {
    steps.push({
      kind: 'action',
      id: 'fallback',
      request: {
        adapterId: fallbackId,
        actionId: 'fallback',
        capability: 'fixture.fallback',
        effect: 'observe-only',
        idempotency: 'read-only',
      },
    });
  }
  return { id: `readonly-retry-${maxRetries}-${fallbackId ?? 'none'}`, entry: 'read', steps };
}

const unknown: ComputerActionResult = {
  status: 'unknown',
  dispatch: 'unknown',
  verification: 'unverified',
  evidence: ['readonly-transport-unknown'],
};
const completed: ComputerActionResult = {
  status: 'completed',
  dispatch: 'not-dispatched',
  verification: 'verified',
  evidence: ['readonly-completed'],
};

test('read-only action may retry after unknown dispatch and complete within the same runtime', async () => {
  const source = new SequenceAdapter('compute:readonly-retry-success', 'fixture.read', [unknown, completed]);

  const result = await new ComputerTaskRuntime(task(source.descriptor.id), registry(source), {
    executionId: EXECUTION_ID,
  }).run();

  assert.equal(result.status, 'completed');
  assert.equal(source.actions, 2);
  assert.ok(result.evidence?.includes('readonly-completed'));
});

test('exhausted read-only unknown retries terminate unknown and cannot take a generic fallback edge', async () => {
  const source = new SequenceAdapter('compute:readonly-retry-exhausted', 'fixture.read', [unknown]);
  const fallback = new SequenceAdapter('compute:readonly-retry-fallback', 'fixture.fallback', [completed]);

  const result = await new ComputerTaskRuntime(
    task(source.descriptor.id, fallback.descriptor.id, 1),
    registry(source, fallback),
    { executionId: EXECUTION_ID },
  ).run();

  assert.equal(result.status, 'unknown-dispatch');
  assert.equal(source.actions, 2);
  assert.equal(fallback.actions, 0);
});

test('read-only unknown dispatch persisted in a checkpoint still requires reconciliation instead of replay on resume', async () => {
  const source = new SequenceAdapter('compute:readonly-checkpoint', 'fixture.read', [unknown]);
  const program = task(source.descriptor.id, undefined, 0);
  const firstRuntime = new ComputerTaskRuntime(program, registry(source), { executionId: EXECUTION_ID });
  const first = await firstRuntime.run();

  assert.equal(first.status, 'unknown-dispatch');
  assert.equal(source.actions, 1);

  const checkpoint = decodeComputerTaskCheckpoint(encodeComputerTaskCheckpoint(firstRuntime.checkpoint()));
  const replacement = new SequenceAdapter('compute:readonly-checkpoint', 'fixture.read', [completed]);
  const resumed = await new ComputerTaskRuntime(program, registry(replacement), {
    executionId: EXECUTION_ID,
    checkpoint,
  }).run();

  assert.equal(resumed.status, 'reconciliation-required');
  assert.equal(replacement.actions, 0);
});
