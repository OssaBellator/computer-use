import test from 'node:test';
import assert from 'node:assert/strict';
import {
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEnvironmentAdapter,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import {
  type ComputerTaskActionStep,
  type ComputerTaskProgram,
} from '../src/computer/computerTask.js';
import {
  computerTaskProgramHash,
  createComputerTaskCheckpoint,
  type ComputerTaskCheckpoint,
} from '../src/computer/computerTaskCheckpoint.js';
import {
  COMPUTER_TASK_MAX_RETAINED_OBSERVATIONS,
  ComputerTaskRuntime,
} from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '0123456789abcdef0123456789abcdef';

class ReviewFakeAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor = {
    id: 'fake',
    kind: 'desktop-ui' as const,
    version: '1',
    capabilities: ['fake.read', 'fake.write'],
  };

  actCount = 0;
  observeCount = 0;
  lastAction?: ComputerActionRequest;
  nextResult: ComputerActionResult = { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' };

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    this.observeCount += 1;
    return {
      adapterId: 'fake',
      environment: 'desktop-ui',
      channel: request.channel,
      sequence: this.observeCount,
      complete: true,
      truncated: false,
      surface: request.surface,
      target: request.target,
      data: { secretSentinel: 'raw-observation-must-not-be-retained' },
    };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actCount += 1;
    this.lastAction = request;
    return this.nextResult;
  }
}

function setup(): { adapter: ReviewFakeAdapter; registry: ComputerEnvironmentRegistry } {
  const adapter = new ReviewFakeAdapter();
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);
  return { adapter, registry };
}

function program(step: ComputerTaskActionStep): ComputerTaskProgram {
  return { id: 'review-program', entry: step.id, steps: [step] };
}

function simpleAction(overrides: Partial<ComputerTaskActionStep> = {}): ComputerTaskActionStep {
  return {
    kind: 'action',
    id: 'write',
    request: {
      adapterId: 'fake',
      actionId: 'write',
      capability: 'fake.write',
      effect: 'local-reversible',
      idempotency: 'idempotent',
    },
    ...overrides,
  };
}

test('runtime dispatch is bound to immutable validated snapshot across awaited approval', async () => {
  const { adapter, registry } = setup();
  const mutablePayload = { value: 'original' };
  const mutableStep: ComputerTaskActionStep = {
    kind: 'action',
    id: 'write',
    request: {
      adapterId: 'fake',
      actionId: 'write',
      capability: 'fake.write',
      effect: 'external-communication',
      idempotency: 'non-idempotent',
      payload: mutablePayload,
    },
    checkpointBinding: 'binding-original-0001',
  };
  const task = program(mutableStep);
  const runtime = new ComputerTaskRuntime(task, registry, {
    executionId: EXECUTION_ID,
    hooks: {
      approve: async () => {
        await Promise.resolve();
        mutableStep.request.capability = 'fake.read';
        mutableStep.request.effect = 'observe-only';
        mutablePayload.value = 'mutated-after-validation';
        return true;
      },
    },
  });

  const result = await runtime.run();
  assert.equal(result.status, 'completed');
  assert.equal(adapter.actCount, 1);
  assert.equal(adapter.lastAction?.capability, 'fake.write');
  assert.equal(adapter.lastAction?.effect, 'external-communication');
  assert.deepEqual(adapter.lastAction?.payload, { value: 'original' });
  assert.notEqual(adapter.lastAction?.payload, mutablePayload);
});

test('snapshot rejects accessor-backed executable fields before reading them', () => {
  const { registry } = setup();
  let getterReads = 0;
  const request = {
    adapterId: 'fake',
    actionId: 'write',
    effect: 'local-reversible' as const,
    idempotency: 'idempotent' as const,
  } as ComputerActionRequest;
  Object.defineProperty(request, 'capability', {
    enumerable: true,
    configurable: true,
    get: () => {
      getterReads += 1;
      return getterReads === 1 ? 'fake.write' : 'fake.read';
    },
  });
  const task = program({ kind: 'action', id: 'write', request });

  assert.throws(
    () => new ComputerTaskRuntime(task, registry, { executionId: EXECUTION_ID }),
    /accessor property/,
  );
  assert.equal(getterReads, 0);
});

test('snapshot rejects cyclic and oversized executable payload graphs', () => {
  const { registry } = setup();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  assert.throws(
    () => new ComputerTaskRuntime(program(simpleAction({
      request: { ...simpleAction().request, payload: cyclic },
      checkpointBinding: 'cyclic-binding-0001',
    })), registry, { executionId: EXECUTION_ID }),
    /cyclic executable value/,
  );

  const oversized = Array.from({ length: 20_100 }, () => 0);
  assert.throws(
    () => new ComputerTaskRuntime(program(simpleAction({
      request: { ...simpleAction().request, payload: oversized },
      checkpointBinding: 'oversized-bind-0001',
    })), registry, { executionId: EXECUTION_ID }),
    /snapshot item budget|snapshot byte budget/,
  );
});

test('request target cannot bypass task freshness binding', () => {
  const { registry } = setup();
  const task = program({
    kind: 'action',
    id: 'write',
    request: {
      adapterId: 'fake',
      actionId: 'write',
      capability: 'fake.write',
      effect: 'local-reversible',
      idempotency: 'idempotent',
      target: {
        adapterId: 'fake',
        environment: 'desktop-ui',
        kind: 'ui-control',
        entityId: 'entity:1',
        surfaceId: 'surface:1',
        generation: 1,
      },
    },
  });
  assert.throws(
    () => new ComputerTaskRuntime(task, registry, { executionId: EXECUTION_ID }),
    /request target requires an identical action target entity/,
  );
});

test('payload-bearing actions require a non-secret checkpoint binding and binding changes program identity', () => {
  const { registry } = setup();
  const withoutBinding = program({
    kind: 'action',
    id: 'write',
    request: {
      adapterId: 'fake',
      actionId: 'write',
      capability: 'fake.write',
      effect: 'local-reversible',
      idempotency: 'idempotent',
      payload: { value: 'one' },
    },
  });
  assert.throws(
    () => new ComputerTaskRuntime(withoutBinding, registry, { executionId: EXECUTION_ID }),
    /payload-bearing actions require checkpointBinding/,
  );

  const first = program({
    ...withoutBinding.steps[0] as ComputerTaskActionStep,
    checkpointBinding: 'trusted-revision-0001',
  });
  const second = program({
    ...withoutBinding.steps[0] as ComputerTaskActionStep,
    request: { ...(withoutBinding.steps[0] as ComputerTaskActionStep).request, payload: { value: 'two' } },
    checkpointBinding: 'trusted-revision-0002',
  });
  assert.notEqual(computerTaskProgramHash(first), computerTaskProgramHash(second));

  const checkpoint = createComputerTaskCheckpoint({
    program: first,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 0,
    actions: { write: 'not-started' },
  });
  assert.throws(
    () => new ComputerTaskRuntime(second, registry, { executionId: EXECUTION_ID, checkpoint }),
    /checkpoint does not match program/,
  );
});

test('run retains only bounded metadata records and never raw observation data', async () => {
  const { registry } = setup();
  const steps = Array.from({ length: 10 }, (_, index) => ({
    kind: 'observe' as const,
    id: `read-${index}`,
    request: { adapterId: 'fake', channel: 'semantic-ui' as const },
    next: `read-${(index + 1) % 10}`,
  }));
  const task: ComputerTaskProgram = { id: 'observation-cycle', entry: 'read-0', steps };
  const result = await new ComputerTaskRuntime(task, registry, { executionId: EXECUTION_ID }).run();

  assert.equal(result.status, 'failed');
  assert.equal(result.observations.length, COMPUTER_TASK_MAX_RETAINED_OBSERVATIONS);
  assert.ok(result.observationsDropped > 0);
  assert.equal(JSON.stringify(result.observations).includes('raw-observation-must-not-be-retained'), false);
  assert.equal('data' in result.observations[0]!, false);
});

test('hook evidence is restricted to bounded machine-readable codes', async () => {
  const { registry } = setup();
  const task = program(simpleAction({ verification: 'domain.verify' }));
  const result = await new ComputerTaskRuntime(task, registry, {
    executionId: EXECUTION_ID,
    hooks: {
      verifiers: {
        'domain.verify': async () => ({
          state: 'mismatch',
          evidence: ['valid-code', 'SECRET user@example.com', 'x'.repeat(100)],
        }),
      },
    },
  }).run();

  assert.equal(result.status, 'verification-mismatch');
  assert.ok(result.evidence?.includes('valid-code'));
  assert.ok(result.evidence?.includes('runtime-evidence-invalid'));
  assert.equal(result.evidence?.some((entry) => entry.includes('SECRET') || entry.length > 64), false);
});

test('throwing verifier after known dispatch is checkpointed non-replayably before the verifier await', async () => {
  const first = setup();
  const task = program(simpleAction({ verification: 'domain.throw' }));
  const hooks = {
    verifiers: {
      'domain.throw': async () => {
        throw new Error('verifier transport failed');
      },
    },
  };
  const runtime = new ComputerTaskRuntime(task, first.registry, { executionId: EXECUTION_ID, hooks });
  const result = await runtime.run();
  assert.equal(result.status, 'unverified');
  assert.equal(first.adapter.actCount, 1);
  assert.ok(result.evidence?.includes('verifier-threw-after-dispatch'));

  const checkpoint = runtime.checkpoint();
  assert.equal(checkpoint.actions[0]?.state, 'dispatched-unverified');
  const resumed = setup();
  const resumedResult = await new ComputerTaskRuntime(task, resumed.registry, {
    executionId: EXECUTION_ID,
    checkpoint,
    hooks,
  }).run();
  assert.equal(resumedResult.status, 'reconciliation-required');
  assert.equal(resumed.adapter.actCount, 0);
});

test('throwing verifier after unknown dispatch is checkpointed unknown and never replayed', async () => {
  const first = setup();
  first.adapter.nextResult = { status: 'unknown', dispatch: 'unknown', verification: 'unverified' };
  const task = program(simpleAction({ verification: 'domain.throw' }));
  const hooks = {
    verifiers: {
      'domain.throw': async () => {
        throw new Error('verifier transport failed');
      },
    },
  };
  const runtime = new ComputerTaskRuntime(task, first.registry, { executionId: EXECUTION_ID, hooks });
  const result = await runtime.run();
  assert.equal(result.status, 'unknown-dispatch');
  assert.equal(first.adapter.actCount, 1);

  const checkpoint = runtime.checkpoint();
  assert.equal(checkpoint.actions[0]?.state, 'unknown-dispatch');
  const resumed = setup();
  const resumedResult = await new ComputerTaskRuntime(task, resumed.registry, {
    executionId: EXECUTION_ID,
    checkpoint,
    hooks,
  }).run();
  assert.equal(resumedResult.status, 'reconciliation-required');
  assert.equal(resumed.adapter.actCount, 0);
});

test('direct typed checkpoint resume requires runtime provenance and explicit action history', () => {
  const { registry } = setup();
  const task = program(simpleAction());
  const forgedCheckpoint = {
    version: 1,
    program: { id: task.id, hash: computerTaskProgramHash(task) },
    execution: { id: EXECUTION_ID },
    cursor: { nextStepId: 'write', stepsExecuted: 1 },
    actions: [{ stepId: 'write', state: 'not-started' }],
  } as ComputerTaskCheckpoint;

  assert.throws(
    () => new ComputerTaskRuntime(task, registry, { executionId: EXECUTION_ID, checkpoint: forgedCheckpoint }),
    /lacks runtime provenance/,
  );

  const trusted = createComputerTaskCheckpoint({
    program: task,
    executionId: EXECUTION_ID,
    nextStepId: 'write',
    stepsExecuted: 0,
    actions: {},
  });
  const runtime = new ComputerTaskRuntime(task, registry, { executionId: EXECUTION_ID, checkpoint: trusted });
  assert.ok(runtime);
});
