import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComputerAdapterRoutingError,
  ComputerEnvironmentRegistry,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEnvironmentAdapter,
  type ComputerEnvironmentAdapterDescriptor,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
} from '../src/index.js';

function baseAdapter(id: string, capabilities: readonly string[] = []): ComputerEnvironmentAdapter {
  return {
    descriptor: { id, kind: 'filesystem', version: '1', capabilities },
    async observe(request): Promise<ComputerObservationEnvelope> {
      return {
        adapterId: id,
        environment: 'filesystem',
        channel: request.channel,
        sequence: 1,
        complete: true,
        truncated: false,
        data: {},
      };
    },
    async act(): Promise<ComputerActionResult> {
      return { status: 'unsupported', dispatch: 'not-dispatched', verification: 'unverified' };
    },
  };
}

test('descriptor acquisition failure is classified as invalid descriptor', () => {
  const adapter = {
    get descriptor(): ComputerEnvironmentAdapterDescriptor {
      throw new Error('descriptor accessor failed');
    },
    async observe() { throw new Error('unreachable'); },
    async act() { throw new Error('unreachable'); },
  } as ComputerEnvironmentAdapter;
  const registry = new ComputerEnvironmentRegistry();

  assert.throws(
    () => registry.register(adapter),
    (error: unknown) => error instanceof ComputerAdapterRoutingError && error.code === 'invalid-descriptor',
  );
  assert.deepEqual(registry.descriptors(), []);
});

test('observation request acquisition failure is invalid before adapter invocation', async () => {
  let observeCount = 0;
  const adapter = baseAdapter('filesystem:observe-request');
  adapter.observe = async (request) => {
    observeCount += 1;
    return {
      adapterId: request.adapterId,
      environment: 'filesystem',
      channel: request.channel,
      sequence: 1,
      complete: true,
      truncated: false,
      data: {},
    };
  };
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  const request = Object.defineProperties({}, {
    adapterId: { enumerable: true, value: 'filesystem:observe-request' },
    channel: { enumerable: true, value: 'filesystem' },
    surface: {
      enumerable: true,
      get() { throw new Error('surface accessor failed'); },
    },
  }) as ComputerObservationRequest;

  await assert.rejects(
    registry.observe(request),
    (error: unknown) => error instanceof ComputerAdapterRoutingError && error.code === 'invalid-observation-request',
  );
  assert.equal(observeCount, 0);
});

test('observation response acquisition failure is classified as invalid response', async () => {
  const adapter = baseAdapter('filesystem:observe-response');
  adapter.observe = async () => Object.defineProperties({}, {
    adapterId: { enumerable: true, value: 'filesystem:observe-response' },
    environment: { enumerable: true, value: 'filesystem' },
    channel: { enumerable: true, value: 'filesystem' },
    sequence: {
      enumerable: true,
      get() { throw new Error('sequence accessor failed'); },
    },
    complete: { enumerable: true, value: true },
    truncated: { enumerable: true, value: false },
    data: { enumerable: true, value: {} },
  }) as ComputerObservationEnvelope;
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  await assert.rejects(
    registry.observe({ adapterId: 'filesystem:observe-response', channel: 'filesystem' }),
    (error: unknown) => error instanceof ComputerAdapterRoutingError && error.code === 'invalid-observation-response',
  );
});

test('action request acquisition failure is rejected as definitely not dispatched', async () => {
  let actCount = 0;
  const adapter = baseAdapter('filesystem:action-request', ['filesystem.write']);
  adapter.act = async () => {
    actCount += 1;
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
  };
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  const request = Object.defineProperties({}, {
    adapterId: { enumerable: true, value: 'filesystem:action-request' },
    actionId: { enumerable: true, value: 'write' },
    capability: {
      enumerable: true,
      get() { throw new Error('capability accessor failed'); },
    },
    effect: { enumerable: true, value: 'local-reversible' },
    idempotency: { enumerable: true, value: 'non-idempotent' },
  }) as ComputerActionRequest;

  const result = await registry.act(request);
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.deepEqual(result.evidence, ['invalid-action-request']);
  assert.equal(actCount, 0);
});

test('action result acquisition failure after invocation remains unknown dispatch', async () => {
  let actCount = 0;
  const adapter = baseAdapter('filesystem:action-response', ['filesystem.write']);
  adapter.act = async () => {
    actCount += 1;
    return Object.defineProperties({}, {
      status: {
        enumerable: true,
        get() { throw new Error('status accessor failed'); },
      },
      dispatch: { enumerable: true, value: 'dispatched-once' },
      verification: { enumerable: true, value: 'verified' },
    }) as ComputerActionResult;
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
  assert.equal(result.status, 'unknown');
  assert.equal(result.dispatch, 'unknown');
  assert.deepEqual(result.evidence, ['adapter-threw-after-invocation']);
  assert.equal(actCount, 1);
});
