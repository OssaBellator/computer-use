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

test('composition exposes validated descriptor lookup without exposing its registry', () => {
  const descriptor = {
    id: 'filesystem:descriptor',
    kind: 'filesystem' as const,
    version: '1.0.0',
    capabilities: ['filesystem.read'],
  };
  const adapter: ComputerEnvironmentAdapter = {
    descriptor,
    async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
      return {
        adapterId: descriptor.id,
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

  const composition = createComputerRuntimeComposition([adapter]);
  const registered = composition.descriptor('filesystem:descriptor');
  assert.deepEqual(registered, descriptor);
  assert.equal(composition.descriptor('filesystem:missing'), undefined);

  descriptor.version = 'mutated-after-registration';
  descriptor.capabilities.push('filesystem.write');

  assert.deepEqual(composition.descriptor('filesystem:descriptor'), {
    id: 'filesystem:descriptor',
    kind: 'filesystem',
    version: '1.0.0',
    capabilities: ['filesystem.read'],
  });
});
