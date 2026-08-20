import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComputerEnvironmentRegistry,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEnvironmentAdapter,
  type ComputerObservationEnvelope,
} from '../src/index.js';

function counted<T>(counts: Map<string, number>, key: string, value: T): PropertyDescriptor {
  return {
    enumerable: true,
    configurable: true,
    get() {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return value;
    },
  };
}

test('registry acquires neutral observation response metadata once and returns a frozen snapshot', async () => {
  const counts = new Map<string, number>();
  const data = { opaque: true };
  const surface = { adapterId: 'filesystem:response', environment: 'filesystem' as const, surfaceId: 'root', generation: 1 };
  const response = Object.defineProperties({}, {
    adapterId: counted(counts, 'adapterId', 'filesystem:response'),
    environment: counted(counts, 'environment', 'filesystem'),
    channel: counted(counts, 'channel', 'filesystem'),
    sequence: counted(counts, 'sequence', 1),
    complete: counted(counts, 'complete', true),
    truncated: counted(counts, 'truncated', false),
    surface: counted(counts, 'surface', surface),
    target: counted(counts, 'target', undefined),
    data: counted(counts, 'data', data),
  }) as ComputerObservationEnvelope;

  const adapter: ComputerEnvironmentAdapter = {
    descriptor: { id: 'filesystem:response', kind: 'filesystem', version: '1', capabilities: [] },
    async observe() { return response; },
    async act() { return { status: 'unsupported', dispatch: 'not-dispatched', verification: 'unverified' }; },
  };
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  const result = await registry.observe({ adapterId: 'filesystem:response', channel: 'filesystem' });
  for (const key of ['adapterId', 'environment', 'channel', 'sequence', 'complete', 'truncated', 'surface', 'target', 'data']) {
    assert.equal(counts.get(key), 1, `${key} should be acquired once`);
  }
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.surface), true);
  assert.equal(result.data, data, 'opaque observation data remains adapter-owned');
});

test('registry acquires neutral action result metadata once and snapshots evidence', async () => {
  const counts = new Map<string, number>();
  const details = { opaque: true };
  const evidence = ['adapter.completed'];
  const response = Object.defineProperties({}, {
    status: counted(counts, 'status', 'completed'),
    dispatch: counted(counts, 'dispatch', 'dispatched-once'),
    verification: counted(counts, 'verification', 'verified'),
    evidence: counted(counts, 'evidence', evidence),
    details: counted(counts, 'details', details),
  }) as ComputerActionResult;

  const adapter: ComputerEnvironmentAdapter = {
    descriptor: {
      id: 'filesystem:action-response',
      kind: 'filesystem',
      version: '1',
      capabilities: ['filesystem.write'],
    },
    async observe(request): Promise<ComputerObservationEnvelope> {
      return {
        adapterId: request.adapterId,
        environment: 'filesystem',
        channel: request.channel,
        sequence: 1,
        complete: true,
        truncated: false,
        data: {},
      };
    },
    async act(_request: ComputerActionRequest) { return response; },
  };
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  const result = await registry.act({
    adapterId: 'filesystem:action-response',
    actionId: 'write',
    capability: 'filesystem.write',
    effect: 'local-reversible',
    idempotency: 'non-idempotent',
  });
  for (const key of ['status', 'dispatch', 'verification', 'evidence', 'details']) {
    assert.equal(counts.get(key), 1, `${key} should be acquired once`);
  }
  evidence.push('mutated-after-return');
  assert.deepEqual(result.evidence, ['adapter.completed']);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.evidence), true);
  assert.equal(result.details, details, 'opaque action details remain adapter-owned');
});

test('registry rejects oversized action evidence without acquiring its entries', async () => {
  let evidenceEntryReads = 0;
  const evidence = new Array<string>(33);
  Object.defineProperty(evidence, '0', {
    enumerable: true,
    configurable: true,
    get() {
      evidenceEntryReads += 1;
      return 'must-not-be-acquired';
    },
  });

  const adapter: ComputerEnvironmentAdapter = {
    descriptor: {
      id: 'filesystem:oversized-evidence',
      kind: 'filesystem',
      version: '1',
      capabilities: ['filesystem.write'],
    },
    async observe(request): Promise<ComputerObservationEnvelope> {
      return {
        adapterId: request.adapterId,
        environment: 'filesystem',
        channel: request.channel,
        sequence: 1,
        complete: true,
        truncated: false,
        data: {},
      };
    },
    async act(): Promise<ComputerActionResult> {
      return {
        status: 'completed',
        dispatch: 'dispatched-once',
        verification: 'verified',
        evidence,
      };
    },
  };
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  const result = await registry.act({
    adapterId: 'filesystem:oversized-evidence',
    actionId: 'write',
    capability: 'filesystem.write',
    effect: 'local-reversible',
    idempotency: 'non-idempotent',
  });

  assert.equal(evidenceEntryReads, 0, 'oversized evidence must be rejected before copying entries');
  assert.deepEqual(result.evidence, ['adapter-evidence-invalid']);
  assert.equal(Object.isFrozen(result.evidence), true);
});
