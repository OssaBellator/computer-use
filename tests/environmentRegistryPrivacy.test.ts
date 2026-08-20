import test from 'node:test';
import assert from 'node:assert/strict';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerEnvironmentAdapter } from '../src/computer/environmentAdapter.js';

test('registry replaces unbounded or prose-like adapter evidence without changing dispatch state', async () => {
  const adapter: ComputerEnvironmentAdapter = {
    descriptor: {
      id: 'process-primary',
      kind: 'process',
      version: '1',
      capabilities: ['process.launch'],
    },
    async observe(request) {
      return {
        adapterId: 'process-primary', environment: 'process', channel: request.channel,
        sequence: 0, complete: true, truncated: false, data: {},
      };
    },
    async act() {
      return {
        status: 'completed',
        dispatch: 'dispatched-once',
        verification: 'verified',
        evidence: ['command output contained private user text'],
      };
    },
  };
  const registry = new ComputerEnvironmentRegistry();
  registry.register(adapter);
  const result = await registry.act({
    adapterId: 'process-primary',
    actionId: 'launch-1',
    capability: 'process.launch',
    effect: 'process-trigger',
    idempotency: 'non-idempotent',
  });
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(result.verification, 'verified');
  assert.deepEqual(result.evidence, ['adapter-evidence-invalid']);
  assert.equal(JSON.stringify(result).includes('private user text'), false);
});
