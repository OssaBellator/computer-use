import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_COMPUTE_CAPABILITY } from '../src/computer/localComputeAdapter.js';
import { IsolatedLocalComputeAdapter } from '../src/computer/isolatedLocalComputeAdapter.js';

const moduleUrl = new URL('./fixtures/isolatedLocalComputeOperations.js', import.meta.url).href;

function request() {
  return {
    adapterId: 'artifact-store-test',
    actionId: 'artifact-store-action',
    capability: LOCAL_COMPUTE_CAPABILITY,
    effect: 'local-reversible',
    idempotency: 'non-idempotent',
    payload: {
      job: { jobId: 'artifact-store-job', generation: 0 },
      operation: 'test.artifact',
      input: 'value',
    },
  } as const;
}

test('isolated artifact creation fails closed when verified output cannot fit the artifact store', async () => {
  const adapter = new IsolatedLocalComputeAdapter({
    id: 'artifact-store-test',
    operations: [{ id: 'test.artifact', effect: 'local-artifact-creation', moduleUrl, exportName: 'artifact' }],
    maxArtifactStoreBytes: 8,
  });

  const first = await adapter.act(request());
  assert.equal(first.status, 'failed');
  assert.equal(first.dispatch, 'dispatched-once');
  assert.equal(first.verification, 'rejected');
  assert.deepEqual(first.evidence, ['compute-isolated-artifact-store-limit']);
  assert.equal((first.details as any).job.executionState, 'failed');
  assert.equal((first.details as any).job.outputArtifact, undefined);

  const replay = await adapter.act(request());
  assert.equal(replay.status, 'failed');
  assert.equal(replay.dispatch, 'dispatched-once');
  assert.deepEqual(replay.evidence, ['compute-isolated-known-failed']);
});
