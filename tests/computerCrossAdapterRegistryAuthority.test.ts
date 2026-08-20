import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerEnvironmentKind,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import {
  ComputerAdapterRoutingError,
  ComputerEnvironmentRegistry,
} from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '77777777777777777777777777777777';

class MutableAuthorityAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: {
    id: string;
    kind: ComputerEnvironmentKind;
    version: string;
    capabilities: string[];
  };
  actions = 0;
  observations = 0;

  constructor(id: string, kind: ComputerEnvironmentKind, capabilities: string[]) {
    this.descriptor = { id, kind, version: 'authority-1', capabilities };
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    this.observations += 1;
    return {
      adapterId: this.descriptor.id,
      environment: this.descriptor.kind,
      channel: request.channel,
      sequence: this.observations,
      complete: true,
      truncated: false,
      data: null,
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actions += 1;
    return {
      status: 'completed',
      dispatch: 'not-dispatched',
      verification: 'verified',
      evidence: ['authority-adapter-ok'],
    };
  }
}

function actionProgram(adapterId: string, capability: string, effect: 'observe-only' | 'local-reversible' = 'observe-only'): ComputerTaskProgram {
  return {
    id: `registry-authority-${capability}`,
    entry: 'act',
    steps: [{
      kind: 'action',
      id: 'act',
      request: {
        adapterId,
        actionId: 'act',
        capability,
        effect,
        idempotency: effect === 'observe-only' ? 'read-only' : 'idempotent',
      },
    }],
  };
}

test('post-registration capability mutation cannot expand registry authority, but explicit replacement can', async () => {
  const registry = new ComputerEnvironmentRegistry();
  const original = new MutableAuthorityAdapter('compute:authority', 'local-compute', ['fixture.read']);
  registry.register(original);

  original.descriptor.capabilities.push('fixture.write');
  original.descriptor.version = 'authority-mutated';

  assert.deepEqual(registry.descriptor(original.descriptor.id), {
    id: 'compute:authority',
    kind: 'local-compute',
    version: 'authority-1',
    capabilities: ['fixture.read'],
  });

  const program = actionProgram('compute:authority', 'fixture.write', 'local-reversible');
  const denied = await new ComputerTaskRuntime(program, registry, {
    executionId: EXECUTION_ID,
    hooks: { approve: async () => true },
  }).run();

  assert.equal(denied.status, 'unsupported');
  assert.equal(original.actions, 0);

  assert.equal(registry.unregister('compute:authority'), true);
  const replacement = new MutableAuthorityAdapter('compute:authority', 'local-compute', ['fixture.write']);
  registry.register(replacement);

  const allowed = await new ComputerTaskRuntime(program, registry, {
    executionId: EXECUTION_ID,
    hooks: { approve: async () => true },
  }).run();

  assert.equal(allowed.status, 'completed');
  assert.equal(original.actions, 0);
  assert.equal(replacement.actions, 1);
});

test('duplicate adapter id cannot hijack routing authority from the registered adapter', async () => {
  const registry = new ComputerEnvironmentRegistry();
  const original = new MutableAuthorityAdapter('compute:duplicate', 'local-compute', ['fixture.read']);
  const hijacker = new MutableAuthorityAdapter('compute:duplicate', 'local-compute', ['fixture.read', 'fixture.write']);
  registry.register(original);

  assert.throws(
    () => registry.register(hijacker),
    (error: unknown) => error instanceof ComputerAdapterRoutingError && error.code === 'adapter-already-registered',
  );

  const result = await new ComputerTaskRuntime(
    actionProgram('compute:duplicate', 'fixture.read'),
    registry,
    { executionId: EXECUTION_ID },
  ).run();

  assert.equal(result.status, 'completed');
  assert.equal(original.actions, 1);
  assert.equal(hijacker.actions, 0);
});

test('post-registration kind mutation cannot smuggle a differently typed observation into a later adapter action', async () => {
  const registry = new ComputerEnvironmentRegistry();
  const browser = new MutableAuthorityAdapter('browser:authority', 'browser', ['browser.observe']);
  const compute = new MutableAuthorityAdapter('compute:after-observe', 'local-compute', ['fixture.read']);
  registry.register(browser);
  registry.register(compute);

  browser.descriptor.kind = 'remote-session';

  const program: ComputerTaskProgram = {
    id: 'registry-authority-observation-kind',
    entry: 'observe',
    steps: [
      {
        kind: 'observe',
        id: 'observe',
        request: { adapterId: 'browser:authority', channel: 'semantic-ui' },
        next: 'compute',
      },
      {
        kind: 'action',
        id: 'compute',
        request: {
          adapterId: 'compute:after-observe',
          actionId: 'compute',
          capability: 'fixture.read',
          effect: 'observe-only',
          idempotency: 'read-only',
        },
      },
    ],
  };

  await assert.rejects(
    new ComputerTaskRuntime(program, registry, { executionId: EXECUTION_ID }).run(),
    (error: unknown) => error instanceof ComputerAdapterRoutingError && error.code === 'invalid-observation-response',
  );

  assert.equal(browser.observations, 1);
  assert.equal(compute.actions, 0);
});
