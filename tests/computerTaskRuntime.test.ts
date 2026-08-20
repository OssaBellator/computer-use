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
import { type ComputerTaskActionStep, type ComputerTaskProgram } from '../src/computer/computerTask.js';
import {
  createComputerTaskCheckpoint,
  decodeComputerTaskCheckpoint,
  encodeComputerTaskCheckpoint,
} from '../src/computer/computerTaskCheckpoint.js';
import { ComputerTaskRuntime, type ComputerTaskRuntimeHooks } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';

function surface(generation = 1): ComputerSurfaceRef {
  return { adapterId: 'fake', environment: 'desktop-ui', surfaceId: 'surface:1', generation };
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

type ActPlan = ComputerActionResult | Error | ((adapter: FakeAdapter) => ComputerActionResult | Promise<ComputerActionResult>);

class FakeAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor = {
    id: 'fake', kind: 'desktop-ui', version: '1', capabilities: ['fake.read', 'fake.write'],
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
      adapterId: 'fake', environment: 'desktop-ui', channel: request.channel, sequence: this.observeCount,
      complete: true, truncated: false, surface: request.surface ?? this.currentSurface,
      target: request.target ?? this.currentEntity, data: { synthetic: true },
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actCount += 1;
    const plan = this.plans.shift();
    if (plan instanceof Error) throw plan;
    const result = typeof plan === 'function'
      ? await plan(this)
      : plan ?? { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };
    if (result.dispatch === 'dispatched-once') this.knownDispatches += 1;
    return result;
  }
}

function setup(fake = new FakeAdapter()) {
  const registry = new ComputerEnvironmentRegistry();
  registry.register(fake);
  return { fake, registry };
}

const target = { surface: surface(), entity: entity() };
const revalidateTarget: NonNullable<ComputerTaskRuntimeHooks['revalidateTarget']> = async (registry) => {
  const observation = await registry.observe({
    adapterId: 'fake', channel: 'semantic-ui', limits: { maxItems: 1, maxTextBytes: 64, maxDepth: 1 },
  });
  return { state: 'fresh', surface: observation.surface, entity: observation.target };
};

interface ActionOptions {
  capability?: string;
  effect?: ComputerActionRequest['effect'];
  idempotency?: ComputerActionRequest['idempotency'];
  withTarget?: boolean;
  verification?: string;
  maxRetries?: number;
  payload?: unknown;
  checkpointBinding?: string;
}

function action(options: ActionOptions = {}): ComputerTaskActionStep {
  const withTarget = options.withTarget !== false;
  return {
    kind: 'action',
    id: 'write',
    request: {
      adapterId: 'fake', actionId: 'write', capability: options.capability ?? 'fake.write',
      effect: options.effect ?? 'local-reversible', idempotency: options.idempotency ?? 'non-idempotent',
      target: withTarget ? entity() : undefined, payload: options.payload,
    },
    target: withTarget ? target : undefined,
    verification: options.verification,
    maxRetries: options.maxRetries,
    checkpointBinding: options.checkpointBinding,
  };
}

function program(steps: ComputerTaskProgram['steps'], entry = steps[0]!.id): ComputerTaskProgram {
  return { id: 'neutral-program', entry, steps };
}

async function run(task: ComputerTaskProgram, environment: ReturnType<typeof setup>, hooks: Partial<ComputerTaskRuntimeHooks> = {}) {
  return new ComputerTaskRuntime(task, environment.registry, {
    executionId: EXECUTION_ID,
    hooks: { revalidateTarget, approve: async () => true, ...hooks },
  }).run();
}

test('read-only successful task uses bounded observation defaults', async () => {
  const env = setup();
  const result = await run(program([{ kind: 'observe', id: 'read', request: { adapterId: 'fake', channel: 'semantic-ui' } }]), env);
  assert.equal(result.status, 'completed');
  assert.equal(env.fake.actCount, 0);
  assert.deepEqual(env.fake.lastObservationRequest?.limits, { maxItems: 256, maxTextBytes: 32 * 1024, maxDepth: 8 });
});

test('adapter capability missing fails before invocation', async () => {
  const env = setup();
  const result = await run(program([action({ capability: 'fake.missing', withTarget: false })]), env);
  assert.equal(result.status, 'unsupported');
  assert.equal(env.fake.actCount, 0);
});

test('stale surface generation blocks action', async () => {
  const env = setup(); env.fake.currentSurface = surface(2);
  const result = await run(program([action()]), env);
  assert.equal(result.status, 'stale-target'); assert.ok(result.evidence?.includes('surface-generation-stale')); assert.equal(env.fake.actCount, 0);
});

test('stale entity generation blocks action', async () => {
  const env = setup(); env.fake.currentEntity = entity(2);
  const result = await run(program([action()]), env);
  assert.equal(result.status, 'stale-target'); assert.ok(result.evidence?.includes('entity-generation-stale')); assert.equal(env.fake.actCount, 0);
});

test('approval denied blocks effectful action', async () => {
  const env = setup();
  const result = await run(program([action({ effect: 'external-communication' })]), env, { approve: async () => false });
  assert.equal(result.status, 'rejected'); assert.equal(env.fake.actCount, 0);
});

test('definite pre-dispatch failure permits bounded retry with revalidation', async () => {
  const env = setup();
  env.fake.plans = [
    { status: 'failed', dispatch: 'not-dispatched', verification: 'unverified' },
    { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' },
  ];
  const result = await run(program([action({ effect: 'external-communication', maxRetries: 1 })]), env);
  assert.equal(result.status, 'completed'); assert.equal(env.fake.actCount, 2); assert.equal(env.fake.knownDispatches, 1); assert.ok(env.fake.observeCount >= 3);
});

test('successful action dispatches exactly once', async () => {
  const env = setup(); const result = await run(program([action()]), env);
  assert.equal(result.status, 'completed'); assert.equal(env.fake.actCount, 1); assert.equal(env.fake.knownDispatches, 1);
});

test('adapter throw at invocation maps to unknown dispatch', async () => {
  const env = setup(); env.fake.plans = [new Error('transport failure')];
  const result = await run(program([action({ maxRetries: 3 })]), env);
  assert.equal(result.status, 'unknown-dispatch'); assert.equal(env.fake.actCount, 1); assert.ok(result.evidence?.includes('adapter-threw-after-invocation'));
});

test('adapter throw after potential dispatch maps to unknown', async () => {
  const env = setup(); env.fake.plans = [async (fake) => { fake.sideEffects += 1; throw new Error('lost response'); }];
  const result = await run(program([action({ maxRetries: 3 })]), env);
  assert.equal(result.status, 'unknown-dispatch'); assert.equal(env.fake.sideEffects, 1); assert.equal(env.fake.actCount, 1);
});

test('unknown non-idempotent action is never automatically reissued', async () => {
  const env = setup(); env.fake.plans = [new Error('uncertain'), { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' }];
  const result = await run(program([action({ effect: 'external-communication', maxRetries: 3 })]), env);
  assert.equal(result.status, 'unknown-dispatch'); assert.equal(env.fake.actCount, 1);
});

test('verification mismatch is terminal', async () => {
  const env = setup();
  const result = await run(program([action({ verification: 'domain.verify' })]), env, { verifiers: { 'domain.verify': async () => ({ state: 'mismatch' }) } });
  assert.equal(result.status, 'verification-mismatch');
});

test('verification pending is terminal', async () => {
  const env = setup();
  const result = await run(program([action({ verification: 'domain.verify' })]), env, { verifiers: { 'domain.verify': async () => ({ state: 'pending' }) } });
  assert.equal(result.status, 'verification-pending');
});

test('verification unverified is terminal', async () => {
  const env = setup();
  const result = await run(program([action({ verification: 'domain.verify' })]), env, { verifiers: { 'domain.verify': async () => ({ state: 'unverified' }) } });
  assert.equal(result.status, 'unverified');
});

test('idempotent verified no-op completes without claiming dispatch', async () => {
  const env = setup(); env.fake.plans = [{ status: 'completed', dispatch: 'not-dispatched', verification: 'verified' }];
  const result = await run(program([action({ idempotency: 'idempotent' })]), env);
  assert.equal(result.status, 'completed'); assert.equal(env.fake.knownDispatches, 0); assert.equal(env.fake.actCount, 1);
});

test('checkpoint resume before dispatch invokes once', async () => {
  const env = setup(); const task = program([action()]);
  const checkpoint = createComputerTaskCheckpoint({ program: task, executionId: EXECUTION_ID, nextStepId: 'write', stepsExecuted: 0, actions: { write: 'not-started' } });
  const result = await new ComputerTaskRuntime(task, env.registry, { executionId: EXECUTION_ID, checkpoint, hooks: { revalidateTarget } }).run();
  assert.equal(result.status, 'completed'); assert.equal(env.fake.actCount, 1);
});

test('checkpoint resume after known completion does not redispatch', async () => {
  const env = setup(); const task = program([action()]);
  const checkpoint = createComputerTaskCheckpoint({ program: task, executionId: EXECUTION_ID, nextStepId: 'write', stepsExecuted: 1, actions: { write: 'completed' } });
  const result = await new ComputerTaskRuntime(task, env.registry, { executionId: EXECUTION_ID, checkpoint, hooks: { revalidateTarget } }).run();
  assert.equal(result.status, 'completed'); assert.equal(env.fake.actCount, 0);
});

test('checkpoint around unknown dispatch requires reconciliation without replay', async () => {
  const env = setup(); const task = program([action()]);
  const checkpoint = createComputerTaskCheckpoint({ program: task, executionId: EXECUTION_ID, nextStepId: 'write', stepsExecuted: 1, actions: { write: 'unknown-dispatch' } });
  const result = await new ComputerTaskRuntime(task, env.registry, { executionId: EXECUTION_ID, checkpoint, hooks: { revalidateTarget } }).run();
  assert.equal(result.status, 'reconciliation-required'); assert.equal(env.fake.actCount, 0);
});

test('known dispatched but mismatched verification is checkpointed non-replayable', async () => {
  const first = setup(); const task = program([action({ verification: 'domain.verify' })]);
  const hooks: ComputerTaskRuntimeHooks = { revalidateTarget, verifiers: { 'domain.verify': async () => ({ state: 'mismatch' }) } };
  const runtime = new ComputerTaskRuntime(task, first.registry, { executionId: EXECUTION_ID, hooks });
  assert.equal((await runtime.run()).status, 'verification-mismatch');
  const checkpoint = runtime.checkpoint(); assert.equal(checkpoint.actions[0]?.state, 'dispatched-unverified');
  const resumed = setup();
  const result = await new ComputerTaskRuntime(task, resumed.registry, { executionId: EXECUTION_ID, checkpoint, hooks }).run();
  assert.equal(result.status, 'reconciliation-required'); assert.equal(resumed.fake.actCount, 0);
});

test('adapter response coherence failure becomes unknown without retry', async () => {
  const env = setup(); env.fake.plans = [{ status: 'completed', dispatch: 'unknown', verification: 'verified' }];
  const result = await run(program([action({ maxRetries: 3 })]), env);
  assert.equal(result.status, 'unknown-dispatch'); assert.equal(env.fake.actCount, 1); assert.ok(result.evidence?.includes('adapter-response-invalid'));
});

test('effectful dispatch cannot complete with not-applicable verification', async () => {
  const env = setup(); env.fake.plans = [{ status: 'completed', dispatch: 'dispatched-once', verification: 'not-applicable' }];
  const result = await run(program([action()]), env);
  assert.equal(result.status, 'unverified'); assert.ok(result.evidence?.includes('post-dispatch-verification-required'));
});

test('checkpoint codec omits raw payload while binding its trusted revision', () => {
  const secret = 'never-checkpoint-this-raw-value';
  const task = program([action({ payload: secret, checkpointBinding: 'trusted-revision-0001' })]);
  const checkpoint = createComputerTaskCheckpoint({ program: task, executionId: EXECUTION_ID, nextStepId: 'write', stepsExecuted: 0, actions: { write: 'not-started' } });
  const encoded = encodeComputerTaskCheckpoint(checkpoint);
  assert.deepEqual(decodeComputerTaskCheckpoint(encoded), checkpoint);
  assert.throws(() => decodeComputerTaskCheckpoint(encoded.replace('not-started', 'completed')));
  assert.equal(encoded.includes(secret), false);
  assert.equal(encoded.includes('trusted-revision-0001'), false, 'binding participates through program hash, not raw checkpoint metadata');
});
