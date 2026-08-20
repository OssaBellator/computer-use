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
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';

class FakeAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor = {
    id: 'browser-primary',
    kind: 'browser' as const,
    version: '1',
    capabilities: ['browser.activate', 'browser.open-surface'] as const,
  };
  actionCalls = 0;
  throwOnAction = false;
  badObservation = false;

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    return {
      adapterId: this.badObservation ? 'wrong-adapter' : this.descriptor.id,
      environment: 'browser',
      channel: request.channel,
      sequence: 1,
      complete: true,
      truncated: false,
      data: { count: 1 },
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actionCalls += 1;
    if (this.throwOnAction) throw new Error('transport failed after possible dispatch');
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
  }
}

test('registry routes targetless actions by explicit adapter id', async () => {
  const adapter = new FakeAdapter();
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);
  const result = await registry.act({
    adapterId: 'browser-primary',
    actionId: 'open-1',
    capability: 'browser.open-surface',
    effect: 'local-reversible',
    idempotency: 'non-idempotent',
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(adapter.actionCalls, 1);
});

test('cross-adapter targets and unadvertised capabilities fail before adapter dispatch', async () => {
  const adapter = new FakeAdapter();
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  const mismatched = await registry.act({
    adapterId: 'browser-primary',
    actionId: 'activate-1',
    capability: 'browser.activate',
    effect: 'local-reversible',
    idempotency: 'idempotent',
    target: {
      adapterId: 'desktop-primary', environment: 'desktop-ui', kind: 'ui-control', entityId: 'button-1',
    },
  });
  assert.equal(mismatched.status, 'rejected');
  assert.equal(mismatched.dispatch, 'not-dispatched');
  assert.equal(adapter.actionCalls, 0);

  const unsupported = await registry.act({
    adapterId: 'browser-primary',
    actionId: 'delete-1',
    capability: 'filesystem.delete',
    effect: 'local-destructive',
    idempotency: 'non-idempotent',
  });
  assert.equal(unsupported.status, 'unsupported');
  assert.equal(unsupported.dispatch, 'not-dispatched');
  assert.equal(adapter.actionCalls, 0);
});

test('adapter exception after invocation becomes unknown dispatch rather than retry-safe failure', async () => {
  const adapter = new FakeAdapter();
  adapter.throwOnAction = true;
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);
  const result = await registry.act({
    adapterId: 'browser-primary',
    actionId: 'activate-1',
    capability: 'browser.activate',
    effect: 'external-communication',
    idempotency: 'non-idempotent',
  });
  assert.deepEqual(result, {
    status: 'unknown',
    dispatch: 'unknown',
    verification: 'unverified',
    evidence: ['adapter-threw-after-invocation'],
  });
  assert.equal(adapter.actionCalls, 1);
});

test('observation routing rejects adapter identity drift', async () => {
  const adapter = new FakeAdapter();
  adapter.badObservation = true;
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  await assert.rejects(
    () => registry.observe({ adapterId: 'browser-primary', channel: 'semantic-ui' }),
    (error: unknown) => error instanceof ComputerAdapterRoutingError && error.code === 'invalid-observation-response',
  );
});

test('registry descriptor ordering is locale-independent and duplicate ids are rejected', () => {
  const first = new FakeAdapter();
  const second: ComputerEnvironmentAdapter = {
    descriptor: { id: 'Z-adapter', kind: 'filesystem', version: '1', capabilities: [] },
    async observe(request) {
      return {
        adapterId: 'Z-adapter', environment: 'filesystem', channel: request.channel,
        sequence: 0, complete: true, truncated: false, data: {},
      };
    },
    async act() {
      return { status: 'unsupported', dispatch: 'not-dispatched', verification: 'unverified' };
    },
  };
  const registry = new ComputerEnvironmentRegistry();
  registry.register(first);
  registry.register(second);
  assert.deepEqual(registry.descriptors().map((descriptor) => descriptor.id), ['Z-adapter', 'browser-primary']);
  assert.throws(
    () => registry.register(first),
    (error: unknown) => error instanceof ComputerAdapterRoutingError && error.code === 'adapter-already-registered',
  );
});
