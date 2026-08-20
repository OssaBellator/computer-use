import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComputerAdapterRoutingError,
  createComputerRuntimeComposition,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEnvironmentAdapter,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
} from '../src/index.js';

function adapter(id: string): ComputerEnvironmentAdapter {
  return {
    descriptor: { id, kind: 'filesystem', version: '1.0.0', capabilities: [] },
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
      return { status: 'unsupported', dispatch: 'not-dispatched', verification: 'unverified' };
    },
  };
}

test('duplicate adapter id rejects before acquiring rejected adapter methods', () => {
  const id = 'filesystem:duplicate';
  const composition = createComputerRuntimeComposition([adapter(id)]);
  let methodAccesses = 0;

  const duplicate = {
    descriptor: { id, kind: 'filesystem', version: '2.0.0', capabilities: [] },
    get observe(): ComputerEnvironmentAdapter['observe'] {
      methodAccesses += 1;
      throw new Error('duplicate observe accessor must not run');
    },
    get act(): ComputerEnvironmentAdapter['act'] {
      methodAccesses += 1;
      throw new Error('duplicate act accessor must not run');
    },
  } as unknown as ComputerEnvironmentAdapter;

  assert.throws(
    () => composition.register(duplicate),
    (error: unknown) => error instanceof ComputerAdapterRoutingError && error.code === 'adapter-already-registered',
  );
  assert.equal(methodAccesses, 0);
  assert.equal(composition.descriptor(id)?.version, '1.0.0');
});
