import test from 'node:test';
import assert from 'node:assert/strict';
import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { createComputerTaskCheckpoint, decodeComputerTaskCheckpoint, encodeComputerTaskCheckpoint } from '../src/computer/computerTaskCheckpoint.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';

const task: ComputerTaskProgram = {
  id: 'checkpoint-history-review',
  entry: 'write',
  steps: [{
    kind: 'action',
    id: 'write',
    request: {
      adapterId: 'fake',
      actionId: 'write',
      capability: 'fake.write',
      effect: 'local-reversible',
      idempotency: 'idempotent',
    },
  }],
};

class CapabilityAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  actCount = 0;

  constructor(capabilities: readonly string[]) {
    this.descriptor = {
      id: 'fake',
      kind: 'desktop-ui' as const,
      version: '1',
      capabilities,
    };
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    return {
      adapterId: 'fake',
      environment: 'desktop-ui',
      channel: request.channel,
      sequence: 1,
      complete: true,
      truncated: false,
      data: { synthetic: true },
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actCount += 1;
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
  }
}

function registryWith(capabilities: readonly string[]): { registry: ComputerEnvironmentRegistry; adapter: CapabilityAdapter } {
  const registry = new ComputerEnvironmentRegistry();
  const adapter = new CapabilityAdapter(capabilities);
  registry.register(adapter);
  return { registry, adapter };
}

test('checkpoint rejects rollback-shaped entry action after execution advanced without a reachable history path', () => {
  assert.throws(
    () => createComputerTaskCheckpoint({
      program: task,
      executionId: EXECUTION_ID,
      nextStepId: 'write',
      stepsExecuted: 1,
      actions: { write: 'not-started' },
    }),
    /cursor\/action history is inconsistent/,
  );
});

test('observe then unstarted action remains a valid checkpoint after action preflight stops', async () => {
  const observeThenAction: ComputerTaskProgram = {
    id: 'checkpoint-observe-action-review',
    entry: 'read',
    steps: [
      {
        kind: 'observe',
        id: 'read',
        request: { adapterId: 'fake', channel: 'semantic-ui' },
        next: 'write',
      },
      {
        kind: 'action',
        id: 'write',
        request: {
          adapterId: 'fake',
          actionId: 'write',
          capability: 'fake.write',
          effect: 'local-reversible',
          idempotency: 'idempotent',
        },
      },
    ],
  };

  const first = registryWith([]);
  const runtime = new ComputerTaskRuntime(observeThenAction, first.registry, { executionId: EXECUTION_ID });
  const stopped = await runtime.run();
  assert.equal(stopped.status, 'unsupported');
  assert.equal(stopped.stepsExecuted, 1);
  assert.equal(stopped.nextStepId, 'write');
  assert.equal(first.adapter.actCount, 0);

  const checkpoint = runtime.checkpoint();
  assert.equal(checkpoint.actions.find((action) => action.stepId === 'write')?.state, 'not-started');

  const resumed = registryWith(['fake.write']);
  const result = await new ComputerTaskRuntime(observeThenAction, resumed.registry, {
    executionId: EXECUTION_ID,
    checkpoint,
  }).run();
  assert.equal(result.status, 'completed');
  assert.equal(resumed.adapter.actCount, 1);
});

test('long-horizon resume context survives checkpoint encoding and must match exactly before execution', async () => {
  const first = registryWith([]);
  const runtime = new ComputerTaskRuntime(task, first.registry, {
    executionId: EXECUTION_ID,
    resumeContext: {
      'auth.account': 'account:work',
      'auth.session-generation': 'session-generation:42',
      'authority.revision': 'policy:2026-08-27:a1',
    },
  });
  const checkpoint = decodeComputerTaskCheckpoint(encodeComputerTaskCheckpoint(runtime.checkpoint()));
  assert.deepEqual(checkpoint.resumeContext, [
    { key: 'auth.account', value: 'account:work' },
    { key: 'auth.session-generation', value: 'session-generation:42' },
    { key: 'authority.revision', value: 'policy:2026-08-27:a1' },
  ]);

  const matching = registryWith(['fake.write']);
  const result = await new ComputerTaskRuntime(task, matching.registry, {
    executionId: EXECUTION_ID,
    checkpoint,
    resumeContext: {
      'authority.revision': 'policy:2026-08-27:a1',
      'auth.session-generation': 'session-generation:42',
      'auth.account': 'account:work',
    },
  }).run();
  assert.equal(result.status, 'completed');
  assert.equal(matching.adapter.actCount, 1);
});

test('long-horizon resume fails closed on account/session/authority drift before adapter execution', () => {
  const environment = registryWith(['fake.write']);
  const checkpoint = createComputerTaskCheckpoint({
    program: task,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 0,
    actions: { write: 'not-started' },
    resumeContext: { 'auth.account': 'account:work', 'auth.session-generation': 'session-generation:42' },
  });
  assert.throws(() => new ComputerTaskRuntime(task, environment.registry, {
    executionId: EXECUTION_ID,
    checkpoint,
    resumeContext: { 'auth.account': 'account:other', 'auth.session-generation': 'session-generation:42' },
  }), /resume context mismatch/);
  assert.equal(environment.adapter.actCount, 0);
  assert.throws(() => new ComputerTaskRuntime(task, environment.registry, {
    executionId: EXECUTION_ID,
    checkpoint,
  }), /resume context mismatch/);
});

test('checkpoint resume cannot reset the cumulative task step budget', async () => {
  const boundedProgram: ComputerTaskProgram = {
    id: 'long-horizon-budget-review',
    entry: 'observe',
    steps: [
      { kind: 'observe', id: 'observe', request: { adapterId: 'fake', channel: 'semantic-ui' }, next: 'write' },
      {
        kind: 'action',
        id: 'write',
        request: {
          adapterId: 'fake',
          actionId: 'write',
          capability: 'fake.write',
          effect: 'local-reversible',
          idempotency: 'idempotent',
        },
      },
    ],
  };
  const checkpoint = createComputerTaskCheckpoint({
    program: boundedProgram,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: boundedProgram.steps.length * 7,
    actions: { write: 'not-started' },
  });
  const environment = registryWith(['fake.write']);
  const result = await new ComputerTaskRuntime(boundedProgram, environment.registry, {
    executionId: EXECUTION_ID,
    checkpoint,
  }).run();
  assert.equal(result.status, 'failed');
  assert.ok(result.evidence?.includes('task-step-budget-exhausted'));
  assert.equal(environment.adapter.actCount, 0);
});

test('resume context is bounded metadata and rejects invalid or excessive bindings', () => {
  const environment = registryWith([]);
  assert.throws(() => new ComputerTaskRuntime(task, environment.registry, {
    executionId: EXECUTION_ID,
    resumeContext: { 'bad key with spaces': 'opaque-value' },
  }), /invalid binding/);
  const tooMany = Object.fromEntries(Array.from({ length: 33 }, (_, index) => [`binding:${index}`, `value:${index}`]));
  assert.throws(() => new ComputerTaskRuntime(task, environment.registry, {
    executionId: EXECUTION_ID,
    resumeContext: tooMany,
  }), /exceeds 32 bindings/);
});

test('continuation gate can suspend before dispatch without consuming step budget or cursor state', async () => {
  const environment = registryWith(['fake.write']);
  const runtime = new ComputerTaskRuntime(task, environment.registry, {
    executionId: EXECUTION_ID,
    hooks: { continuationGate: async () => ({ state: 'suspend', evidence: ['auth-user-presence-required'] }) },
  });
  const result = await runtime.run();
  assert.equal(result.status, 'suspended');
  assert.equal(result.stepsExecuted, 0);
  assert.equal(result.nextStepId, 'write');
  assert.equal(environment.adapter.actCount, 0);
  assert.ok(result.evidence?.includes('auth-user-presence-required'));
  const checkpoint = runtime.checkpoint();
  assert.equal(checkpoint.cursor.stepsExecuted, 0);
  assert.equal(checkpoint.cursor.nextStepId, 'write');
  assert.equal(checkpoint.actions.find((entry) => entry.stepId === 'write')?.state, 'not-started');
});

test('continuation gate exception fails closed into suspension before adapter execution', async () => {
  const environment = registryWith(['fake.write']);
  const result = await new ComputerTaskRuntime(task, environment.registry, {
    executionId: EXECUTION_ID,
    hooks: { continuationGate: async () => { throw new Error('authority-provider-unavailable'); } },
  }).run();
  assert.equal(result.status, 'suspended');
  assert.ok(result.evidence?.includes('continuation-gate-unknown'));
  assert.equal(environment.adapter.actCount, 0);
});

test('durable checkpoint sink receives unknown-dispatch fence before adapter dispatch and completed state after verification', async () => {
  const environment = registryWith(['fake.write']);
  const checkpoints = [] as ReturnType<ComputerTaskRuntime['checkpoint']>[];
  const runtime = new ComputerTaskRuntime(task, environment.registry, {
    executionId: EXECUTION_ID,
    hooks: { checkpointSink: async (checkpoint) => { checkpoints.push(checkpoint); } },
  });
  const result = await runtime.run();
  assert.equal(result.status, 'completed');
  assert.equal(environment.adapter.actCount, 1);
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[0]?.actions.find((entry) => entry.stepId === 'write')?.state, 'unknown-dispatch');
  assert.equal(checkpoints[0]?.cursor.stepsExecuted, 0);
  assert.equal(checkpoints[1]?.actions.find((entry) => entry.stepId === 'write')?.state, 'completed');
  assert.equal(checkpoints[1]?.cursor.stepsExecuted, 1);
});

test('ambiguous pre-dispatch checkpoint persistence prevents dispatch and leaves conservative reconciliation state', async () => {
  const environment = registryWith(['fake.write']);
  let fenced: ReturnType<ComputerTaskRuntime['checkpoint']> | undefined;
  const runtime = new ComputerTaskRuntime(task, environment.registry, {
    executionId: EXECUTION_ID,
    hooks: { checkpointSink: async (checkpoint) => { fenced = checkpoint; throw new Error('durable-store-unknown'); } },
  });
  const result = await runtime.run();
  assert.equal(result.status, 'suspended');
  assert.ok(result.evidence?.includes('checkpoint-persistence-unknown-before-dispatch'));
  assert.equal(environment.adapter.actCount, 0);
  assert.equal(runtime.checkpoint().actions.find((entry) => entry.stepId === 'write')?.state, 'unknown-dispatch');
  assert.ok(fenced);

  const resumed = registryWith(['fake.write']);
  const resumedResult = await new ComputerTaskRuntime(task, resumed.registry, {
    executionId: EXECUTION_ID,
    checkpoint: fenced!,
  }).run();
  assert.equal(resumedResult.status, 'reconciliation-required');
  assert.equal(resumed.adapter.actCount, 0);
});

test('verifier cannot mutate dispatch fields to bypass effectful post-dispatch verification', async () => {
  const environment = registryWith(['fake.write']);
  const verifyTask: ComputerTaskProgram = {
    id: 'immutable-adapter-result-review',
    entry: 'write',
    steps: [{
      kind: 'action',
      id: 'write',
      request: {
        adapterId: 'fake',
        actionId: 'write',
        capability: 'fake.write',
        effect: 'local-reversible',
        idempotency: 'idempotent',
      },
      verification: 'domain.verify',
    }],
  };

  const result = await new ComputerTaskRuntime(verifyTask, environment.registry, {
    executionId: EXECUTION_ID,
    hooks: {
      verifiers: {
        'domain.verify': async ({ adapterResult }) => {
          assert.equal(Object.isFrozen(adapterResult), true);
          let mutationRejected = false;
          try {
            adapterResult.dispatch = 'not-dispatched';
          } catch {
            mutationRejected = true;
          }
          assert.equal(mutationRejected, true);
          assert.equal(adapterResult.dispatch, 'dispatched-once');
          return { state: 'not-applicable' };
        },
      },
    },
  }).run();

  assert.equal(result.status, 'unverified');
  assert.ok(result.evidence?.includes('post-dispatch-verification-required'));
  assert.equal(environment.adapter.actCount, 1);
});

test('zero-step checkpoint cannot move cursor away from program entry', () => {
  const twoStepTask: ComputerTaskProgram = {
    id: 'checkpoint-zero-step-review',
    entry: 'read',
    steps: [
      { kind: 'observe', id: 'read', request: { adapterId: 'fake', channel: 'semantic-ui' }, next: 'write' },
      task.steps[0]!,
    ],
  };
  assert.throws(
    () => createComputerTaskCheckpoint({
      program: twoStepTask,
      executionId: EXECUTION_ID,
      nextStepId: 'write',
      stepsExecuted: 0,
      actions: { write: 'not-started' },
    }),
    /zero-step cursor must remain at program entry/,
  );
});
