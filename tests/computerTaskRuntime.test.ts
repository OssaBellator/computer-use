import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEntityRef,
  type ComputerEnvironmentAdapter,
  type ComputerEnvironmentAdapterDescriptor,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
  type ComputerSurfaceRef,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import {
  type ComputerTaskActionStep,
  type ComputerTaskProgram,
} from '../src/computer/computerTask.js';
import {
  createComputerTaskCheckpoint,
  decodeComputerTaskCheckpoint,
  encodeComputerTaskCheckpoint,
} from '../src/computer/computerTaskCheckpoint.js';
import {
  ComputerTaskRuntime,
  type ComputerTaskRuntimeHooks,
} from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';

function surface(generation = 1): ComputerSurfaceRef {
  return {
    adapterId: 'fake',
    environment: 'desktop-ui',
    surfaceId: 'surface:1',
    generation,
  };
}

function entity(generation = 1): ComputerEntityRef {
  return {
    adapterId: 'fake',
    environment: 'desktop-ui',
    kind: 'ui-control',
    entityId: 'entity:1',
    surfaceId: 'surface:1',
    generation,
  };
}

type ActPlan =
  | ComputerActionResult
  | Error
  | ((adapter: FakeAdapter, request: ComputerActionRequest) => ComputerActionResult | Promise<ComputerActionResult>);

class FakeAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor = {
    id: 'fake',
    kind: 'desktop-ui',
    version: '1',
    capabilities: ['fake.read', 'fake.write'],
  };

  currentSurface = surface();
  currentEntity = entity();
  plans: ActPlan[] = [];
  observeCount = 0;
  actCount = 0;
  knownDispatches = 0;
  sideEffects = 0;
  lastObservationRequest?: ComputerObservationRequest;

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    this.observeCount += 1;
    this.lastObservationRequest = request;
    return {
      adapterId: 'fake',
      environment: 'desktop-ui',
      channel: request.channel,
      sequence: this.observeCount,
      complete: true,
      truncated: false,
      surface: request.surface ?? this.currentSurface,
      target: request.target ?? this.currentEntity,
      data: { synthetic: true },
    };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actCount += 1;
    const plan = this.plans.shift();
    if (plan instanceof Error) throw plan;
    const result = typeof plan === 'function'
      ? await plan(this, request)
      : plan ?? { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
    if (result.dispatch === 'dispatched-once') this.knownDispatches += 1;
    return result;
  }
}

function setup(fake = new FakeAdapter()): { fake: FakeAdapter; registry: ComputerEnvironmentRegistry } {
  const registry = new ComputerEnvironmentRegistry();
  registry.register(fake);
  return { fake, registry };
}

const target = { surface: surface(), entity: entity() };

const revalidateTarget: NonNullable<ComputerTaskRuntimeHooks['revalidateTarget']> = async (registry) => {
  const observation = await registry.observe({
    adapterId: 'fake',
    channel: 'semantic-ui',
    limits: { maxItems: 1, maxTextBytes: 64, maxDepth: 1 },
  });
  return { state: 'fresh', surface: observation.surface, entity: observation.target };
};

interface ActionOptions {
  id?: string;
  capability?: string;
  effect?: ComputerActionRequest['effect'];
  idempotency?: ComputerActionRequest['idempotency'];
  withTarget?: boolean;
  verification?: string;
  maxRetries?: number;
  onSuccess?: string;
  onFailure?: string;
  payload?: unknown;
}

function action(options: ActionOptions = {}): ComputerTaskActionStep {
  const id = options.id ?? 'write';
  const withTarget = options.withTarget !== false;
  return {
    kind: 'action',
    id,
    request: {
      adapterId: 'fake',
      actionId: id,
      capability: options.capability ?? 'fake.write',
      effect: options.effect ?? 'local-reversible',
      idempotency: options.idempotency ?? 'non-idempotent',
      target: withTarget ? entity() : undefined,
      payload: options.payload,
    },
    target: withTarget ? target : undefined,
    verification: options.verification,
    maxRetries: options.maxRetries,
    onSuccess: options.onSuccess,
    onFailure: options.onFailure,
  };
}

function program(steps: ComputerTaskProgram['steps'], entry = steps[0]!.id): ComputerTaskProgram {
  return { id: 'neutral-program', entry, steps };
}

async function run(
  task: ComputerTaskProgram,
  environment: ReturnType<typeof setup>,
  options: { checkpoint?: ReturnType<typeof createComputerTaskCheckpoint>; hooks?: Partial<ComputerTaskRuntimeHooks> } = {},
) {
  const hooks: ComputerTaskRuntimeHooks = {
    revalidateTarget,
    approve: async () => true,
    ...options.hooks,
  };
  return new ComputerTaskRuntime(task, environment.registry, {
    executionId: EXECUTION_ID,
    checkpoint: options.checkpoint,
    hooks,
  }).run();
}

test('read-only observation task succeeds with runtime observation bounds', async () => {
  const environment = setup();
  const result = await run(program([{
    kind: 'observe',
    id: 'read',
    request: { adapterId: 'fake', channel: 'semantic-ui' },
  }]), environment);

  assert.equal(result.status, 'completed');
  assert.equal(environment.fake.actCount, 0);
  assert.equal(environment.fake.observeCount, 1);
  assert.deepEqual(environment.fake.lastObservationRequest?.limits, {
    maxItems: 256,
    maxTextBytes: 32 * 1024,
    maxDepth: 8,
  });
});

test('missing adapter capability fails preflight without invocation', async () => {
  const environment = setup();
  const result = await run(program([action({ capability: 'fake.missing', withTarget: false })]), environment);
  assert.equal(result.status, 'unsupported');
  assert.equal(environment.fake.actCount, 0);
});

test('stale surface generation blocks action before dispatch', async () => {
  const environment = setup();
  environment.fake.currentSurface = surface(2);
  const result = await run(program([action()]), environment);
  assert.equal(result.status, 'stale-target');
  assert.ok(result.evidence?.includes('surface-generation-stale'));
  assert.equal(environment.fake.actCount, 0);
});

test('stale entity generation blocks action before dispatch', async () => {
  const environment = setup();
  environment.fake.currentEntity = entity(2);
  const result = await run(program([action()]), environment);
  assert.equal(result.status, 'stale-target');
  assert.ok(result.evidence?.includes('entity-generation-stale'));
  assert.equal(environment.fake.actCount, 0);
});

test('approval denied blocks effectful action', async () => {
  const environment = setup();
  const result = await run(program([action({ effect: 'external-communication' })]), environment, {
    hooks: { approve: async () => false },
  });
  assert.equal(result.status, 'rejected');
  assert.equal(environment.fake.actCount, 0);
});

test('definite pre-dispatch failure can retry after fresh revalidation', async () => {
  const environment = setup();
  environment.fake.plans = [
    { status: 'failed', dispatch: 'not-dispatched', verification: 'unverified' },
    { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' },
  ];
  const result = await run(program([action({ effect: 'external-communication', maxRetries: 1 })]), environment);
  assert.equal(result.status, 'completed');
  assert.equal(environment.fake.actCount, 2);
  assert.equal(environment.fake.knownDispatches, 1);
  assert.ok(environment.fake.observeCount >= 3, 'initial, post-approval, and retry pre-dispatch revalidation must occur');
});

test('successful action dispatches exactly once', async () => {
  const environment = setup();
  const result = await run(program([action()]), environment);
  assert.equal(result.status, 'completed');
  assert.equal(environment.fake.actCount, 1);
  assert.equal(environment.fake.knownDispatches, 1);
});

test('adapter throw before dispatch can be known maps to unknown dispatch', async () => {
  const environment = setup();
  environment.fake.plans = [new Error('transport failed at invocation')];
  const result = await run(program([action({ maxRetries: 3 })]), environment);
  assert.equal(result.status, 'unknown-dispatch');
  assert.equal(environment.fake.actCount, 1);
  assert.ok(result.evidence?.includes('adapter-threw-after-invocation'));
});

test('adapter throw after potential side effect maps to unknown dispatch', async () => {
  const environment = setup();
  environment.fake.plans = [async (fake) => {
    fake.sideEffects += 1;
    throw new Error('lost response after potential dispatch');
  }];
  const result = await run(program([action({ maxRetries: 3 })]), environment);
  assert.equal(result.status, 'unknown-dispatch');
  assert.equal(environment.fake.sideEffects, 1);
  assert.equal(environment.fake.actCount, 1);
});

test('unknown non-idempotent action is never automatically reissued', async () => {
  const environment = setup();
  environment.fake.plans = [
    new Error('uncertain dispatch'),
    { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' },
  ];
  const result = await run(program([action({ effect: 'external-communication', maxRetries: 3 })]), environment);
  assert.equal(result.status, 'unknown-dispatch');
  assert.equal(environment.fake.actCount, 1);
});

test('domain verifier mismatch terminates instead of trusting dispatch success', async () => {
  const environment = setup();
  const result = await run(program([action({ verification: 'domain.verify' })]), environment, {
    hooks: { verifiers: { 'domain.verify': async () => ({ state: 'mismatch' }) } },
  });
  assert.equal(result.status, 'verification-mismatch');
  assert.equal(environment.fake.actCount, 1);
});

test('domain verifier pending state remains non-completed', async () => {
  const environment = setup();
  const result = await run(program([action({ verification: 'domain.verify' })]), environment, {
    hooks: { verifiers: { 'domain.verify': async () => ({ state: 'pending' }) } },
  });
  assert.equal(result.status, 'verification-pending');
});

test('domain verifier unverified state remains non-completed', async () => {
  const environment = setup();
  const result = await run(program([action({ verification: 'domain.verify' })]), environment, {
    hooks: { verifiers: { 'domain.verify': async () => ({ state: 'unverified' }) } },
  });
  assert.equal(result.status, 'unverified');
});

test('idempotent verified no-op completes without claiming a dispatch', async () => {
  const environment = setup();
  environment.fake.plans = [{ status: 'completed', dispatch: 'not-dispatched', verification: 'verified' }];
  const result = await run(program([action({ idempotency: 'idempotent' })]), environment);
  assert.equal(result.status, 'completed');
  assert.equal(environment.fake.knownDispatches, 0);
  assert.equal(environment.fake.actCount, 1);
});

test('checkpoint resume before dispatch invokes action once', async () => {
  const environment = setup();
  const task = program([action()]);
  const checkpoint = createComputerTaskCheckpoint({
    program: task,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 0,
    actions: { write: 'not-started' },
  });
  const result = await run(task, environment, { checkpoint });
  assert.equal(result.status, 'completed');
  assert.equal(environment.fake.actCount, 1);
});

test('checkpoint resume after known completion does not redispatch action', async () => {
  const environment = setup();
  const task = program([action()]);
  const checkpoint = createComputerTaskCheckpoint({
    program: task,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 1,
    actions: { write: 'completed' },
  });
  const result = await run(task, environment, { checkpoint });
  assert.equal(result.status, 'completed');
  assert.equal(environment.fake.actCount, 0);
});

test('checkpoint resume around unknown dispatch requires reconciliation and never replays', async () => {
  const environment = setup();
  const task = program([action()]);
  const checkpoint = createComputerTaskCheckpoint({
    program: task,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 1,
    actions: { write: 'unknown-dispatch' },
  });
  const result = await run(task, environment, { checkpoint });
  assert.equal(result.status, 'reconciliation-required');
  assert.equal(environment.fake.actCount, 0);
});

test('checkpoint resume after dispatched but mismatched verification never replays', async () => {
  const first = setup();
  const task = program([action({ verification: 'domain.verify' })]);
  const hooks: ComputerTaskRuntimeHooks = {
    revalidateTarget,
    verifiers: { 'domain.verify': async () => ({ state: 'mismatch' }) },
  };
  const runtime = new ComputerTaskRuntime(task, first.registry, { executionId: EXECUTION_ID, hooks });
  assert.equal((await runtime.run()).status, 'verification-mismatch');
  const checkpoint = runtime.checkpoint();
  assert.equal(checkpoint.actions[0]?.state, 'dispatched-unverified');

  const resumed = setup();
  const result = await new ComputerTaskRuntime(task, resumed.registry, {
    executionId: EXECUTION_ID,
    checkpoint,
    hooks,
  }).run();
  assert.equal(result.status, 'reconciliation-required');
  assert.equal(resumed.fake.actCount, 0);
});

test('adapter response coherence failure becomes unknown and is not retried', async () => {
  const environment = setup();
  environment.fake.plans = [{ status: 'completed', dispatch: 'unknown', verification: 'verified' }];
  const result = await run(program([action({ maxRetries: 3 })]), environment);
  assert.equal(result.status, 'unknown-dispatch');
  assert.equal(environment.fake.actCount, 1);
  assert.ok(result.evidence?.includes('adapter-response-invalid'));
});

test('effectful dispatch cannot complete with not-applicable verification', async () => {
  const environment = setup();
  environment.fake.plans = [{ status: 'completed', dispatch: 'dispatched-once', verification: 'not-applicable' }];
  const result = await run(program([action()]), environment);
  assert.equal(result.status, 'unverified');
  assert.ok(result.evidence?.includes('post-dispatch-verification-required'));
});

test('neutral checkpoint codec round-trips metadata and rejects tampering without raw payloads', () => {
  const secret = 'never-checkpoint-this-raw-value';
  const task = program([action({ payload: secret })]);
  const checkpoint = createComputerTaskCheckpoint({
    program: task,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 0,
    actions: { write: 'not-started' },
  });
  const encoded = encodeComputerTaskCheckpoint(checkpoint);
  assert.deepEqual(decodeComputerTaskCheckpoint(encoded), checkpoint);
  assert.throws(() => decodeComputerTaskCheckpoint(encoded.replace('not-started', 'completed')));
  assert.equal(encoded.includes(secret), false, 'checkpoint stores dispatch metadata, not raw action payload content');
});
