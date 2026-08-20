import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEntityRef,
  ComputerEnvironmentAdapter,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import {
  ComputerAdapterRoutingError,
  ComputerEnvironmentRegistry,
} from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = 'dddddddddddddddddddddddddddddddd';

class OwnershipAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  actions = 0;
  observations = 0;

  constructor(
    id: string,
    kind: 'desktop-ui' | 'local-compute',
    capabilities: readonly string[],
    private readonly responseTarget?: ComputerEntityRef,
  ) {
    this.descriptor = Object.freeze({ id, kind, version: 'target-ownership-1', capabilities: Object.freeze([...capabilities]) });
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
      target: this.responseTarget ?? request.target,
      data: null,
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actions += 1;
    return {
      status: 'completed',
      dispatch: 'dispatched-once',
      verification: 'verified',
      evidence: ['ownership-adapter-ok'],
    };
  }
}

function registry(...adapters: ComputerEnvironmentAdapter[]): ComputerEnvironmentRegistry {
  const value = new ComputerEnvironmentRegistry();
  for (const adapter of adapters) value.register(adapter);
  return value;
}

function targetedActionProgram(adapterId: string, entity: ComputerEntityRef): ComputerTaskProgram {
  return {
    id: `target-ownership-${entity.entityId}`,
    entry: 'activate',
    steps: [{
      kind: 'action',
      id: 'activate',
      request: {
        adapterId,
        actionId: 'activate',
        capability: 'desktop.activate',
        effect: 'local-reversible',
        idempotency: 'idempotent',
        target: entity,
      },
      target: { entity },
    }],
  };
}

test('foreign same-kind target is rejected by task validation before either adapter can receive an action', () => {
  const left = new OwnershipAdapter('desktop:ownership-left', 'desktop-ui', ['desktop.activate']);
  const right = new OwnershipAdapter('desktop:ownership-right', 'desktop-ui', ['desktop.activate']);
  const foreignTarget: ComputerEntityRef = {
    adapterId: right.descriptor.id,
    environment: 'desktop-ui',
    kind: 'ui-control',
    entityId: 'control:right',
    generation: 1,
  };

  assert.throws(
    () => new ComputerTaskRuntime(
      targetedActionProgram(left.descriptor.id, foreignTarget),
      registry(left, right),
      {
        executionId: EXECUTION_ID,
        hooks: {
          revalidateTarget: async () => ({ state: 'fresh', entity: foreignTarget }),
        },
      },
    ),
    /target authority must match request adapterId/,
  );

  assert.equal(left.actions, 0);
  assert.equal(right.actions, 0);
});

test('target environment cannot disagree with the registered adapter kind even when adapterId matches', async () => {
  const desktop = new OwnershipAdapter('desktop:ownership-kind', 'desktop-ui', ['desktop.activate']);
  const wrongEnvironmentTarget: ComputerEntityRef = {
    adapterId: desktop.descriptor.id,
    environment: 'remote-session',
    kind: 'remote-host',
    entityId: 'remote:wrong-kind',
    generation: 1,
  };

  const result = await new ComputerTaskRuntime(
    targetedActionProgram(desktop.descriptor.id, wrongEnvironmentTarget),
    registry(desktop),
    {
      executionId: EXECUTION_ID,
      hooks: {
        revalidateTarget: async () => ({ state: 'fresh', entity: wrongEnvironmentTarget }),
      },
    },
  ).run();

  assert.equal(result.status, 'rejected');
  assert.deepEqual(result.evidence, ['invalid-action-request']);
  assert.equal(desktop.actions, 0);
});

test('observation response cannot claim a target owned by another adapter before downstream action', async () => {
  const foreignTarget: ComputerEntityRef = {
    adapterId: 'desktop:observation-right',
    environment: 'desktop-ui',
    kind: 'ui-control',
    entityId: 'control:foreign-observation',
    generation: 3,
  };
  const left = new OwnershipAdapter('desktop:observation-left', 'desktop-ui', ['desktop.observe'], foreignTarget);
  const right = new OwnershipAdapter('desktop:observation-right', 'desktop-ui', ['desktop.observe']);
  const compute = new OwnershipAdapter('compute:after-foreign-target', 'local-compute', ['fixture.compute']);
  const program: ComputerTaskProgram = {
    id: 'observation-target-ownership-boundary',
    entry: 'observe',
    steps: [
      {
        kind: 'observe',
        id: 'observe',
        request: { adapterId: left.descriptor.id, channel: 'semantic-ui' },
        next: 'compute',
      },
      {
        kind: 'action',
        id: 'compute',
        request: {
          adapterId: compute.descriptor.id,
          actionId: 'compute',
          capability: 'fixture.compute',
          effect: 'observe-only',
          idempotency: 'read-only',
        },
      },
    ],
  };

  await assert.rejects(
    new ComputerTaskRuntime(program, registry(left, right, compute), { executionId: EXECUTION_ID }).run(),
    (error: unknown) => error instanceof ComputerAdapterRoutingError && error.code === 'invalid-observation-response',
  );

  assert.equal(left.observations, 1);
  assert.equal(right.observations, 0);
  assert.equal(compute.actions, 0);
});
