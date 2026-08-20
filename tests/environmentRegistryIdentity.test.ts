import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ComputerAdapterRoutingError,
  ComputerEnvironmentRegistry,
} from '../src/computer/environmentRegistry.js';
import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';

function registryFor(options: {
  observe?: (request: ComputerObservationRequest) => Promise<any>;
  act?: (request: ComputerActionRequest) => Promise<ComputerActionResult>;
} = {}): ComputerEnvironmentRegistry {
  const adapter: ComputerEnvironmentAdapter = {
    descriptor: {
      id: 'desktop-primary',
      kind: 'desktop-ui',
      version: '1',
      capabilities: ['desktop.activate'],
    },
    async observe(request) {
      if (options.observe) return options.observe(request);
      return {
        adapterId: 'desktop-primary',
        environment: 'desktop-ui',
        channel: request.channel,
        sequence: 1,
        complete: true,
        truncated: false,
        surface: request.surface,
        target: request.target,
        data: {},
      };
    },
    async act(request) {
      return options.act?.(request) ?? {
        status: 'completed',
        dispatch: 'dispatched-once',
        verification: 'verified',
      };
    },
  };
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);
  return registry;
}

test('observation responses must preserve requested surface generation identity', async () => {
  const surface = {
    adapterId: 'desktop-primary', environment: 'desktop-ui' as const,
    surfaceId: 'window:7', generation: 4,
  };
  const registry = registryFor({
    async observe(request) {
      return {
        adapterId: 'desktop-primary', environment: 'desktop-ui', channel: request.channel,
        sequence: 1, complete: true, truncated: false,
        surface: { ...surface, generation: 5 }, data: {},
      };
    },
  });
  await assert.rejects(
    () => registry.observe({ adapterId: 'desktop-primary', channel: 'semantic-ui', surface }),
    (error: unknown) => error instanceof ComputerAdapterRoutingError && error.code === 'invalid-observation-response',
  );
});

test('observation responses must preserve requested target identity and surface ownership', async () => {
  const surface = {
    adapterId: 'desktop-primary', environment: 'desktop-ui' as const,
    surfaceId: 'window:7', generation: 4,
  };
  const target = {
    adapterId: 'desktop-primary', environment: 'desktop-ui' as const,
    kind: 'ui-control' as const, entityId: 'button:save', surfaceId: 'window:7', generation: 2,
  };
  const registry = registryFor({
    async observe(request) {
      return {
        adapterId: 'desktop-primary', environment: 'desktop-ui', channel: request.channel,
        sequence: 1, complete: true, truncated: false,
        surface,
        target: { ...target, entityId: 'button:delete', surfaceId: 'window:other' },
        data: {},
      };
    },
  });
  await assert.rejects(
    () => registry.observe({ adapterId: 'desktop-primary', channel: 'semantic-ui', surface, target }),
    (error: unknown) => error instanceof ComputerAdapterRoutingError && error.code === 'invalid-observation-response',
  );
});

test('internally incoherent adapter action results become unknown dispatch', async () => {
  for (const result of [
    { status: 'completed', dispatch: 'unknown', verification: 'verified' },
    { status: 'completed', dispatch: 'dispatched-once', verification: 'unverified' },
    { status: 'failed', dispatch: 'dispatched-once', verification: 'verified' },
    { status: 'unknown', dispatch: 'not-dispatched', verification: 'pending' },
  ] as ComputerActionResult[]) {
    const registry = registryFor({ async act() { return result; } });
    const actual = await registry.act({
      adapterId: 'desktop-primary', actionId: 'activate-1', capability: 'desktop.activate',
      effect: 'local-reversible', idempotency: 'idempotent',
    });
    assert.deepEqual(actual, {
      status: 'unknown', dispatch: 'unknown', verification: 'unverified',
      evidence: ['adapter-response-invalid'],
    });
  }
});

test('verified idempotent no-op completion may remain explicitly not-dispatched', async () => {
  const registry = registryFor({
    async act() {
      return { status: 'completed', dispatch: 'not-dispatched', verification: 'verified', evidence: ['already-satisfied'] };
    },
  });
  const result = await registry.act({
    adapterId: 'desktop-primary', actionId: 'activate-1', capability: 'desktop.activate',
    effect: 'local-reversible', idempotency: 'idempotent',
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(result.verification, 'verified');
});
