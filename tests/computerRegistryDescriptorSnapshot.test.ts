import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ComputerEnvironmentRegistry,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEnvironmentAdapter,
  type ComputerEnvironmentAdapterDescriptor,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
} from '../src/index.js';

test('registry reads adapter descriptor once and installs only that validated snapshot', async () => {
  let descriptorReads = 0;
  const first: ComputerEnvironmentAdapterDescriptor = {
    id: 'filesystem:first',
    kind: 'filesystem',
    version: '1.0.0',
    capabilities: ['filesystem.read'],
  };
  const second: ComputerEnvironmentAdapterDescriptor = {
    id: 'terminal:second',
    kind: 'terminal',
    version: '9.9.9',
    capabilities: ['terminal.execute.argv'],
  };

  const adapter = {
    get descriptor(): ComputerEnvironmentAdapterDescriptor {
      descriptorReads += 1;
      return descriptorReads === 1 ? first : second;
    },
    async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
      return {
        adapterId: 'filesystem:first',
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
  } as ComputerEnvironmentAdapter;

  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);

  assert.equal(descriptorReads, 1);
  assert.deepEqual(registry.descriptors(), [{
    id: 'filesystem:first',
    kind: 'filesystem',
    version: '1.0.0',
    capabilities: ['filesystem.read'],
  }]);
  assert.equal(registry.descriptor('terminal:second'), undefined);

  first.capabilities = ['filesystem.mutated'];
  assert.deepEqual(registry.descriptor('filesystem:first')?.capabilities, ['filesystem.read']);
  assert.equal((await registry.observe({ adapterId: 'filesystem:first', channel: 'filesystem' })).adapterId, 'filesystem:first');
});

test('registry rejects oversized capabilities before copying them into stored authority', () => {
  const capabilities = Array.from({ length: 513 }, (_, index) => `capability.${index}`);
  const adapter: ComputerEnvironmentAdapter = {
    descriptor: {
      id: 'filesystem:oversized',
      kind: 'filesystem',
      version: '1',
      capabilities,
    },
    async observe(request) {
      return {
        adapterId: request.adapterId,
        environment: 'filesystem',
        channel: request.channel,
        sequence: 1,
        complete: true,
        truncated: false,
        data: {},
      };
    },
    async act() {
      return { status: 'unsupported', dispatch: 'not-dispatched', verification: 'unverified' };
    },
  };

  const registry = new ComputerEnvironmentRegistry();
  assert.throws(() => registry.register(adapter), /at most 512 entries/);
  assert.deepEqual(registry.descriptors(), []);
});
