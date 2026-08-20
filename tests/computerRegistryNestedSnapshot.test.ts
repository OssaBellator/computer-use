import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComputerEnvironmentRegistry,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEntityRef,
  type ComputerEnvironmentAdapter,
  type ComputerObservationEnvelope,
  type ComputerObservationLimits,
  type ComputerObservationRequest,
  type ComputerSurfaceRef,
} from '../src/index.js';

function getter<T>(counts: Map<string, number>, key: string, value: T): PropertyDescriptor {
  return {
    enumerable: true,
    configurable: true,
    get() {
      counts.set(key, (counts.get(key) ?? 0) + 1);
      return value;
    },
  };
}

test('registry acquires nested observation surface/entity/limit fields once', async () => {
  const counts = new Map<string, number>();
  const surface = Object.defineProperties({}, {
    adapterId: getter(counts, 'surface.adapterId', 'filesystem:nested'),
    environment: getter(counts, 'surface.environment', 'filesystem'),
    surfaceId: getter(counts, 'surface.surfaceId', 'root'),
    generation: getter(counts, 'surface.generation', 4),
    parentSurfaceId: getter(counts, 'surface.parentSurfaceId', 'parent'),
  }) as ComputerSurfaceRef;
  const target = Object.defineProperties({}, {
    adapterId: getter(counts, 'target.adapterId', 'filesystem:nested'),
    environment: getter(counts, 'target.environment', 'filesystem'),
    kind: getter(counts, 'target.kind', 'directory'),
    entityId: getter(counts, 'target.entityId', 'dir'),
    surfaceId: getter(counts, 'target.surfaceId', 'root'),
    generation: getter(counts, 'target.generation', 7),
  }) as ComputerEntityRef;
  const limits = Object.defineProperties({}, {
    maxItems: getter(counts, 'limits.maxItems', 12),
    maxTextBytes: getter(counts, 'limits.maxTextBytes', 2048),
    maxDepth: getter(counts, 'limits.maxDepth', 3),
  }) as ComputerObservationLimits;

  let received: ComputerObservationRequest | undefined;
  const adapter: ComputerEnvironmentAdapter = {
    descriptor: { id: 'filesystem:nested', kind: 'filesystem', version: '1', capabilities: [] },
    async observe(request): Promise<ComputerObservationEnvelope> {
      received = request;
      return {
        adapterId: request.adapterId,
        environment: 'filesystem',
        channel: request.channel,
        sequence: 1,
        complete: true,
        truncated: false,
        surface: request.surface,
        target: request.target,
        data: {},
      };
    },
    async act(): Promise<ComputerActionResult> {
      return { status: 'unsupported', dispatch: 'not-dispatched', verification: 'unverified' };
    },
  };
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  await registry.observe({
    adapterId: 'filesystem:nested',
    channel: 'filesystem',
    surface,
    target,
    limits,
  });

  for (const key of [
    'surface.adapterId', 'surface.environment', 'surface.surfaceId', 'surface.generation', 'surface.parentSurfaceId',
    'target.adapterId', 'target.environment', 'target.kind', 'target.entityId', 'target.surfaceId', 'target.generation',
    'limits.maxItems', 'limits.maxTextBytes', 'limits.maxDepth',
  ]) {
    assert.equal(counts.get(key), 1, `${key} should be acquired once`);
  }
  assert.equal(received?.surface?.generation, 4);
  assert.equal(received?.surface?.parentSurfaceId, 'parent');
  assert.equal(received?.target?.generation, 7);
  assert.deepEqual(received?.limits, { maxItems: 12, maxTextBytes: 2048, maxDepth: 3 });
});

test('registry acquires nested action target fields once', async () => {
  const counts = new Map<string, number>();
  const target = Object.defineProperties({}, {
    adapterId: getter(counts, 'target.adapterId', 'filesystem:action-nested'),
    environment: getter(counts, 'target.environment', 'filesystem'),
    kind: getter(counts, 'target.kind', 'file'),
    entityId: getter(counts, 'target.entityId', 'file'),
    surfaceId: getter(counts, 'target.surfaceId', 'root'),
    generation: getter(counts, 'target.generation', 11),
  }) as ComputerEntityRef;

  let received: ComputerActionRequest | undefined;
  const adapter: ComputerEnvironmentAdapter = {
    descriptor: {
      id: 'filesystem:action-nested',
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
    async act(request): Promise<ComputerActionResult> {
      received = request;
      return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
    },
  };
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  await registry.act({
    adapterId: 'filesystem:action-nested',
    actionId: 'write',
    capability: 'filesystem.write',
    effect: 'local-reversible',
    idempotency: 'non-idempotent',
    target,
  });

  for (const key of [
    'target.adapterId', 'target.environment', 'target.kind', 'target.entityId', 'target.surfaceId', 'target.generation',
  ]) {
    assert.equal(counts.get(key), 1, `${key} should be acquired once`);
  }
  assert.equal(received?.target?.generation, 11);
  assert.equal(received?.target?.surfaceId, 'root');
});
