import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComputerEnvironmentRegistry,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEnvironmentAdapter,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
} from '../src/index.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('registry snapshots observation routing and generation fields before adapter await', async () => {
  const gate = deferred();
  let received: ComputerObservationRequest | undefined;
  const adapter: ComputerEnvironmentAdapter = {
    descriptor: { id: 'filesystem:snapshot', kind: 'filesystem', version: '1', capabilities: [] },
    async observe(request): Promise<ComputerObservationEnvelope> {
      await gate.promise;
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

  const request: ComputerObservationRequest = {
    adapterId: 'filesystem:snapshot',
    channel: 'filesystem',
    surface: { adapterId: 'filesystem:snapshot', environment: 'filesystem', surfaceId: 'root', generation: 1 },
    target: { adapterId: 'filesystem:snapshot', environment: 'filesystem', kind: 'directory', entityId: 'dir', surfaceId: 'root', generation: 1 },
    limits: { maxItems: 10, maxDepth: 2 },
  };
  const pending = registry.observe(request);
  request.channel = 'process';
  request.surface!.generation = 99;
  request.target!.generation = 99;
  request.limits!.maxItems = 999;
  gate.resolve();

  const result = await pending;
  assert.equal(result.channel, 'filesystem');
  assert.equal(received?.surface?.generation, 1);
  assert.equal(received?.target?.generation, 1);
  assert.equal(received?.limits?.maxItems, 10);
  assert.equal(Object.isFrozen(received), true);
  assert.equal(Object.isFrozen(received?.surface), true);
  assert.equal(Object.isFrozen(received?.target), true);
  assert.equal(Object.isFrozen(received?.limits), true);
});

test('registry snapshots neutral action safety fields while leaving opaque payload adapter-owned', async () => {
  const gate = deferred();
  let received: ComputerActionRequest | undefined;
  const payload = { adapterSpecific: true };
  const adapter: ComputerEnvironmentAdapter = {
    descriptor: {
      id: 'filesystem:action-snapshot',
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
      await gate.promise;
      received = request;
      return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
    },
  };
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  const request: ComputerActionRequest = {
    adapterId: 'filesystem:action-snapshot',
    actionId: 'write',
    capability: 'filesystem.write',
    effect: 'local-reversible',
    idempotency: 'non-idempotent',
    target: {
      adapterId: 'filesystem:action-snapshot',
      environment: 'filesystem',
      kind: 'file',
      entityId: 'file',
      generation: 3,
    },
    payload,
  };
  const pending = registry.act(request);
  request.capability = 'filesystem.missing';
  request.effect = 'security-sensitive';
  request.idempotency = 'unknown';
  request.target!.generation = 77;
  gate.resolve();

  assert.equal((await pending).status, 'completed');
  assert.equal(received?.capability, 'filesystem.write');
  assert.equal(received?.effect, 'local-reversible');
  assert.equal(received?.idempotency, 'non-idempotent');
  assert.equal(received?.target?.generation, 3);
  assert.equal(received?.payload, payload, 'opaque payload snapshotting remains adapter-specific');
  assert.equal(Object.isFrozen(received), true);
  assert.equal(Object.isFrozen(received?.target), true);
});
