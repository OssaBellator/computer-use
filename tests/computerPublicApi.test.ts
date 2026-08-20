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
