import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CdpPipeConnection,
  ComputerEnvironmentRegistry,
  ComputerRuntimeComposition,
  ComputerTaskRuntime,
  computerDocumentModels,
  createComputerRuntimeComposition,
  validateComputerTaskProgram,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEnvironmentAdapter,
  type ComputerEnvironmentKind,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
  type ComputerTaskProgram,
} from '../src/index.js';

function observationAdapter(
  id: string,
  kind: ComputerEnvironmentKind,
  channel: ComputerObservationRequest['channel'],
): ComputerEnvironmentAdapter {
  return {
    descriptor: {
      id,
      kind,
      version: '1.0.0',
      capabilities: [],
    },
    async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
      assert.equal(request.adapterId, id);
      assert.equal(request.channel, channel);
      return {
        adapterId: id,
        environment: kind,
        channel,
        sequence: 1,
        complete: true,
        truncated: false,
        surface: request.surface,
        target: request.target,
        data: { adapter: id },
      };
    },
    async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
      return {
        status: 'unsupported',
        dispatch: 'not-dispatched',
        verification: 'unverified',
      };
    },
  };
}

test('top-level package exports the intentional neutral computer-use surface', () => {
  assert.equal(typeof ComputerEnvironmentRegistry, 'function');
  assert.equal(typeof ComputerRuntimeComposition, 'function');
  assert.equal(typeof ComputerTaskRuntime, 'function');
  assert.equal(typeof createComputerRuntimeComposition, 'function');
  assert.equal(typeof validateComputerTaskProgram, 'function');
  assert.ok(computerDocumentModels.DOCUMENT_KINDS.includes('spreadsheet'));

  // Historical browser exports stay available while the computer surface grows.
  assert.equal(typeof CdpPipeConnection, 'function');
});

test('composition registers peer adapters and runs one neutral task across both', async () => {
  const filesystem = observationAdapter('filesystem:test', 'filesystem', 'filesystem');
  const process = observationAdapter('process:test', 'process', 'process');
  const composition = createComputerRuntimeComposition([process, filesystem]);

  assert.deepEqual(
    composition.descriptors().map(({ id, kind }) => ({ id, kind })),
    [
      { id: 'filesystem:test', kind: 'filesystem' },
      { id: 'process:test', kind: 'process' },
    ],
  );

  const program: ComputerTaskProgram = {
    id: 'public-multi-adapter-composition',
    entry: 'observe-files',
    steps: [
      {
        kind: 'observe',
        id: 'observe-files',
        request: { adapterId: 'filesystem:test', channel: 'filesystem' },
        next: 'observe-processes',
      },
      {
        kind: 'observe',
        id: 'observe-processes',
        request: { adapterId: 'process:test', channel: 'process' },
      },
    ],
  };

  assert.deepEqual(validateComputerTaskProgram(program), []);
  const runtime = composition.createTaskRuntime(program, {
    executionId: '0123456789abcdef0123456789abcdef',
  });
  assert.ok(runtime instanceof ComputerTaskRuntime);

  const result = await runtime.run();
  assert.equal(result.status, 'completed');
  assert.equal(result.stepsExecuted, 2);
  assert.deepEqual(result.observations.map(({ adapterId, channel }) => ({ adapterId, channel })), [
    { adapterId: 'filesystem:test', channel: 'filesystem' },
    { adapterId: 'process:test', channel: 'process' },
  ]);
});

test('composition requires callers to retain runtime checkpoint state after uncertain dispatch', async () => {
  let actCount = 0;
  const uncertainAdapter: ComputerEnvironmentAdapter = {
    descriptor: {
      id: 'terminal:test',
      kind: 'terminal',
      version: '1.0.0',
      capabilities: ['terminal.execute.argv'],
    },
    async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
      return {
        adapterId: 'terminal:test',
        environment: 'terminal',
        channel: request.channel,
        sequence: 1,
        complete: true,
        truncated: false,
        data: {},
      };
    },
    async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
      actCount += 1;
      throw new Error('transport result lost after possible dispatch');
    },
  };

  const composition = createComputerRuntimeComposition([uncertainAdapter]);
  assert.equal('runTask' in composition, false, 'stateless execution convenience must not hide checkpoint state');

  const program: ComputerTaskProgram = {
    id: 'public-uncertain-dispatch',
    entry: 'execute',
    steps: [
      {
        kind: 'action',
        id: 'execute',
        request: {
          adapterId: 'terminal:test',
          actionId: 'execute',
          capability: 'terminal.execute.argv',
          effect: 'local-reversible',
          idempotency: 'non-idempotent',
        },
      },
    ],
  };

  const executionId = 'fedcba9876543210fedcba9876543210';
  const runtime = composition.createTaskRuntime(program, { executionId });
  const first = await runtime.run();
  assert.equal(first.status, 'unknown-dispatch');
  assert.equal(actCount, 1);

  const checkpoint = runtime.checkpoint();
  assert.equal(checkpoint.actions[0]?.state, 'unknown-dispatch');

  const resumed = composition.createTaskRuntime(program, { executionId, checkpoint });
  const second = await resumed.run();
  assert.equal(second.status, 'reconciliation-required');
  assert.equal(actCount, 1, 'resuming from the retained checkpoint must not redispatch');
});

test('task runtime keeps the adapter binding captured at construction', async () => {
  let originalObservations = 0;
  let replacementObservations = 0;

  function trackedAdapter(onObserve: () => void): ComputerEnvironmentAdapter {
    return {
      descriptor: {
        id: 'filesystem:stable',
        kind: 'filesystem',
        version: '1.0.0',
        capabilities: [],
      },
      async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
        onObserve();
        return {
          adapterId: 'filesystem:stable',
          environment: 'filesystem',
          channel: request.channel,
          sequence: 1,
          complete: true,
          truncated: false,
          data: {},
        };
      },
      async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
        return {
          status: 'unsupported',
          dispatch: 'not-dispatched',
          verification: 'unverified',
        };
      },
    };
  }

  const composition = createComputerRuntimeComposition([
    trackedAdapter(() => { originalObservations += 1; }),
  ]);
  const program: ComputerTaskProgram = {
    id: 'public-runtime-adapter-snapshot',
    entry: 'read',
    steps: [
      {
        kind: 'observe',
        id: 'read',
        request: { adapterId: 'filesystem:stable', channel: 'filesystem' },
      },
    ],
  };

  const originalRuntime = composition.createTaskRuntime(program, {
    executionId: '11111111111111111111111111111111',
  });

  assert.equal(composition.unregister('filesystem:stable'), true);
  composition.register(trackedAdapter(() => { replacementObservations += 1; }));

  assert.equal((await originalRuntime.run()).status, 'completed');
  assert.equal(originalObservations, 1);
  assert.equal(replacementObservations, 0, 'existing runtime must not rebind after composition mutation');

  const replacementRuntime = composition.createTaskRuntime(program, {
    executionId: '22222222222222222222222222222222',
  });
  assert.equal((await replacementRuntime.run()).status, 'completed');
  assert.equal(originalObservations, 1);
  assert.equal(replacementObservations, 1, 'new runtime should use the current composition binding');
});
