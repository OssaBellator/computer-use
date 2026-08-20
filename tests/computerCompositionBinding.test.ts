import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createComputerRuntimeComposition,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEnvironmentAdapter,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
  type ComputerTaskProgram,
} from '../src/index.js';

function observation(
  request: ComputerObservationRequest,
  marker: string,
): ComputerObservationEnvelope {
  return {
    adapterId: 'filesystem:bound',
    environment: 'filesystem',
    channel: request.channel,
    sequence: 1,
    complete: true,
    truncated: false,
    data: { marker },
  };
}

test('composition binds adapter methods at registration rather than following later mutation', async () => {
  let originalObservations = 0;
  let replacementObservations = 0;

  const adapter: ComputerEnvironmentAdapter = {
    descriptor: {
      id: 'filesystem:bound',
      kind: 'filesystem',
      version: '1.0.0',
      capabilities: [],
    },
    async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
      originalObservations += 1;
      return observation(request, 'original');
    },
    async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
      return {
        status: 'unsupported',
        dispatch: 'not-dispatched',
        verification: 'unverified',
      };
    },
  };

  const composition = createComputerRuntimeComposition([adapter]);

  adapter.observe = async (request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> => {
    replacementObservations += 1;
    return observation(request, 'replacement');
  };

  const direct = await composition.observe({
    adapterId: 'filesystem:bound',
    channel: 'filesystem',
  });
  assert.deepEqual(direct.data, { marker: 'original' });
  assert.equal(originalObservations, 1);
  assert.equal(replacementObservations, 0);

  const program: ComputerTaskProgram = {
    id: 'bound-observation-route',
    entry: 'observe',
    steps: [
      {
        kind: 'observe',
        id: 'observe',
        request: { adapterId: 'filesystem:bound', channel: 'filesystem' },
      },
    ],
  };
  const runtime = composition.createTaskRuntime(program, {
    executionId: '33333333333333333333333333333333',
  });
  assert.equal((await runtime.run()).status, 'completed');
  assert.equal(originalObservations, 2, 'runtime must use the registration-time bound method');
  assert.equal(replacementObservations, 0);

  assert.equal(composition.unregister('filesystem:bound'), true);
  composition.register(adapter);
  const rebound = await composition.observe({
    adapterId: 'filesystem:bound',
    channel: 'filesystem',
  });
  assert.deepEqual(rebound.data, { marker: 'replacement' });
  assert.equal(replacementObservations, 1, 'explicit re-registration may bind the updated method');
});
