import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createComputerRuntimeComposition,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEnvironmentAdapter,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
} from '../src/index.js';

function validAdapter(id: string): ComputerEnvironmentAdapter {
  return {
    descriptor: {
      id,
      kind: 'filesystem',
      version: '1.0.0',
      capabilities: [],
    },
    async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
      return {
        adapterId: id,
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

test('failed adapter method snapshot leaves composition registration atomic', async () => {
  const composition = createComputerRuntimeComposition();
  const id = 'filesystem:transactional';
  const hostile = {
    descriptor: {
      id,
      kind: 'filesystem',
      version: '1.0.0',
      capabilities: [],
    },
    get observe(): ComputerEnvironmentAdapter['observe'] {
      throw new Error('hostile observe accessor');
    },
    async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
      return {
        status: 'unsupported',
        dispatch: 'not-dispatched',
        verification: 'unverified',
      };
    },
  } as unknown as ComputerEnvironmentAdapter;

  assert.throws(() => composition.register(hostile), /hostile observe accessor/);
  assert.deepEqual(composition.descriptors(), [], 'failed registration must leave no routed descriptor behind');

  composition.register(validAdapter(id));
  assert.deepEqual(composition.descriptors().map(({ id: adapterId }) => adapterId), [id]);
  assert.equal((await composition.observe({ adapterId: id, channel: 'filesystem' })).adapterId, id);
});
