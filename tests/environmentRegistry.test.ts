import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ComputerAdapterRoutingError,
  ComputerEnvironmentRegistry,
} from '../src/computer/environmentRegistry.js';
import { DesktopUiEnvironmentAdapter } from '../src/computer/desktopUiAdapter.js';
import { SyntheticDesktopUiBackend } from '../src/computer/syntheticDesktopUiBackend.js';
import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerEnvironmentAdapterDescriptor,
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

test('runtime-invalid effect/idempotency/capability values fail before adapter dispatch', async () => {
  const adapter = new FakeAdapter();
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  const malformed = {
    adapterId: 'browser-primary',
    actionId: 'bad-1',
    capability: 'browser activate with prose',
    effect: 'totally-safe',
    idempotency: 'repeat-it',
  } as unknown as ComputerActionRequest;
  const result = await registry.act(malformed);
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(adapter.actionCalls, 0);

  const inconsistent = {
    adapterId: 'browser-primary',
    actionId: 'bad-2',
    capability: 'browser.activate',
    effect: 'external-communication',
    idempotency: 'read-only',
  } as ComputerActionRequest;
  const second = await registry.act(inconsistent);
  assert.equal(second.status, 'rejected');
  assert.equal(second.dispatch, 'not-dispatched');
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

test('registry preserves targeted desktop surface and entity identity', async () => {
  const backend = new SyntheticDesktopUiBackend();
  backend.windows = [{nativeWindowId:'win-1',generation:3,foreground:true,focused:true}];
  backend.accessibility.set('win-1@3', {
    status:'available',
    window:{nativeWindowId:'win-1',generation:3},
    root:{controlId:'root',children:[{controlId:'field',role:'textbox'}]},
  });
  const adapter = new DesktopUiEnvironmentAdapter(backend, 'desktop-registry');
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);
  const surface = {adapterId:'desktop-registry',environment:'desktop-ui' as const,surfaceId:'win-1',generation:3};
  const target = {adapterId:'desktop-registry',environment:'desktop-ui' as const,kind:'ui-control' as const,entityId:'field',surfaceId:'win-1',generation:3};

  const observation = await registry.observe({adapterId:'desktop-registry',channel:'semantic-ui',surface,target});
  assert.deepEqual(observation.surface, surface);
  assert.deepEqual(observation.target, target);
});

test('registered descriptor authority is snapshotted and cannot be expanded later', async () => {
  const descriptor: ComputerEnvironmentAdapterDescriptor = {
    id: 'mutable-adapter',
    kind: 'browser',
    version: '1',
    capabilities: ['browser.activate'],
  };
  let actionCalls = 0;
  const adapter: ComputerEnvironmentAdapter = {
    descriptor,
    async observe(request) {
      return {
        adapterId: 'mutable-adapter', environment: 'browser', channel: request.channel,
        sequence: 0, complete: true, truncated: false, data: {},
      };
    },
    async act() {
      actionCalls += 1;
      return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
    },
  };
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  descriptor.kind = 'filesystem';
  descriptor.capabilities = ['browser.activate', 'filesystem.delete'];

  assert.equal(registry.descriptor('mutable-adapter')?.kind, 'browser');
  assert.deepEqual(registry.descriptor('mutable-adapter')?.capabilities, ['browser.activate']);
  const result = await registry.act({
    adapterId: 'mutable-adapter',
    actionId: 'delete-1',
    capability: 'filesystem.delete',
    effect: 'local-destructive',
    idempotency: 'non-idempotent',
  });
  assert.equal(result.status, 'unsupported');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(actionCalls, 0);
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
