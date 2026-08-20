import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEntityRef,
  ComputerEnvironmentAdapter,
  ComputerEnvironmentKind,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = 'cccccccccccccccccccccccccccccccc';

class GateAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  actions = 0;
  observations = 0;

  constructor(id: string, kind: ComputerEnvironmentKind, capabilities: readonly string[]) {
    this.descriptor = Object.freeze({ id, kind, version: 'predispatch-gate-1', capabilities: Object.freeze([...capabilities]) });
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
      dispatch: 'dispatched-once',
      verification: 'verified',
      evidence: ['gate-adapter-ok'],
    };
  }
}

function registry(...adapters: ComputerEnvironmentAdapter[]): ComputerEnvironmentRegistry {
  const value = new ComputerEnvironmentRegistry();
  for (const adapter of adapters) value.register(adapter);
  return value;
}

function targetedProgram(adapter: GateAdapter, fallback: GateAdapter, entity: ComputerEntityRef): ComputerTaskProgram {
  return {
    id: 'predispatch-target-gate-boundary',
    entry: 'activate',
    steps: [
      {
        kind: 'action',
        id: 'activate',
        request: {
          adapterId: adapter.descriptor.id,
          actionId: 'activate',
          capability: 'desktop.activate',
          effect: 'local-reversible',
          idempotency: 'idempotent',
          target: entity,
        },
        target: { entity },
        onFailure: 'fallback',
      },
      {
        kind: 'action',
        id: 'fallback',
        request: {
          adapterId: fallback.descriptor.id,
          actionId: 'fallback',
          capability: 'fixture.fallback',
          effect: 'observe-only',
          idempotency: 'read-only',
        },
      },
    ],
  };
}

test('approval exception after a prior adapter observation aborts before effectful dispatch or fallback routing', async () => {
  const browser = new GateAdapter('browser:approval-gate', 'browser', ['browser.observe']);
  const terminal = new GateAdapter('terminal:approval-gate', 'terminal', ['fixture.execute']);
  const fallback = new GateAdapter('compute:approval-fallback', 'local-compute', ['fixture.fallback']);
  const program: ComputerTaskProgram = {
    id: 'predispatch-approval-exception',
    entry: 'observe',
    steps: [
      {
        kind: 'observe',
        id: 'observe',
        request: { adapterId: browser.descriptor.id, channel: 'semantic-ui' },
        next: 'execute',
      },
      {
        kind: 'action',
        id: 'execute',
        request: {
          adapterId: terminal.descriptor.id,
          actionId: 'execute',
          capability: 'fixture.execute',
          effect: 'process-execution',
          idempotency: 'non-idempotent',
        },
        onFailure: 'fallback',
      },
      {
        kind: 'action',
        id: 'fallback',
        request: {
          adapterId: fallback.descriptor.id,
          actionId: 'fallback',
          capability: 'fixture.fallback',
          effect: 'observe-only',
          idempotency: 'read-only',
        },
      },
    ],
  };

  await assert.rejects(
    new ComputerTaskRuntime(program, registry(browser, terminal, fallback), {
      executionId: EXECUTION_ID,
      hooks: { approve: async () => { throw new Error('private-approval-failure'); } },
    }).run(),
    /private-approval-failure/,
  );

  assert.equal(browser.observations, 1);
  assert.equal(terminal.actions, 0);
  assert.equal(fallback.actions, 0);
});

test('first target revalidation exception aborts before approval or adapter dispatch', async () => {
  const desktop = new GateAdapter('desktop:first-revalidation', 'desktop-ui', ['desktop.activate']);
  const fallback = new GateAdapter('compute:first-revalidation-fallback', 'local-compute', ['fixture.fallback']);
  const entity: ComputerEntityRef = {
    adapterId: desktop.descriptor.id,
    environment: 'desktop-ui',
    kind: 'ui-control',
    entityId: 'control:first',
    generation: 1,
  };
  let approvals = 0;

  await assert.rejects(
    new ComputerTaskRuntime(targetedProgram(desktop, fallback, entity), registry(desktop, fallback), {
      executionId: EXECUTION_ID,
      hooks: {
        revalidateTarget: async () => { throw new Error('private-first-revalidation-failure'); },
        approve: async () => { approvals += 1; return true; },
      },
    }).run(),
    /private-first-revalidation-failure/,
  );

  assert.equal(approvals, 0);
  assert.equal(desktop.actions, 0);
  assert.equal(fallback.actions, 0);
});

test('second target revalidation exception after approval still aborts before dispatch', async () => {
  const desktop = new GateAdapter('desktop:second-revalidation', 'desktop-ui', ['desktop.activate']);
  const fallback = new GateAdapter('compute:second-revalidation-fallback', 'local-compute', ['fixture.fallback']);
  const entity: ComputerEntityRef = {
    adapterId: desktop.descriptor.id,
    environment: 'desktop-ui',
    kind: 'ui-control',
    entityId: 'control:second',
    generation: 2,
  };
  let revalidations = 0;
  let approvals = 0;

  await assert.rejects(
    new ComputerTaskRuntime(targetedProgram(desktop, fallback, entity), registry(desktop, fallback), {
      executionId: EXECUTION_ID,
      hooks: {
        revalidateTarget: async () => {
          revalidations += 1;
          if (revalidations === 2) throw new Error('private-second-revalidation-failure');
          return { state: 'fresh', entity };
        },
        approve: async () => { approvals += 1; return true; },
      },
    }).run(),
    /private-second-revalidation-failure/,
  );

  assert.equal(revalidations, 2);
  assert.equal(approvals, 1);
  assert.equal(desktop.actions, 0);
  assert.equal(fallback.actions, 0);
});
