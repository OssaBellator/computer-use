import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_COMPUTE_CAPABILITY } from '../src/computer/localComputeAdapter.js';
import { IsolatedLocalComputeAdapter } from '../src/computer/isolatedLocalComputeAdapter.js';

const moduleUrl = new URL('./fixtures/isolatedLocalComputeOperations.js', import.meta.url).href;

function request(adapterId: string, jobId: string) {
  return {
    adapterId,
    actionId: `action-${jobId}`,
    capability: LOCAL_COMPUTE_CAPABILITY,
    effect: 'observe-only',
    idempotency: 'read-only',
    payload: {
      job: { jobId, generation: 0 },
      operation: 'test.busy-forever',
      input: null,
      limits: { timeBudgetMs: 5_000 },
    },
  } as const;
}

test('post-spawn communication failure waits for child exit acknowledgement', async () => {
  const adapter = new IsolatedLocalComputeAdapter({
    id: 'ipc-cleanup-confirmed',
    operations: [{ id: 'test.busy-forever', effect: 'pure-read-only', moduleUrl, exportName: 'busyForever' }],
    communicationFailureOperationIds: ['test.busy-forever'],
    terminationAcknowledgeMs: 500,
  });

  const result = await adapter.act(request('ipc-cleanup-confirmed', 'confirmed'));
  assert.equal(result.status, 'unknown');
  assert.equal(result.dispatch, 'unknown');
  assert.equal(result.verification, 'unverified');
  assert.deepEqual(result.evidence, ['compute-isolated-launch-uncertain']);
  assert.equal((result.details as any).job.executionState, 'unknown');
});

test('unconfirmed post-spawn communication cleanup waits the bounded acknowledgement interval', async () => {
  const acknowledgeMs = 100;
  const adapter = new IsolatedLocalComputeAdapter({
    id: 'ipc-cleanup-uncertain',
    operations: [{ id: 'test.busy-forever', effect: 'pure-read-only', moduleUrl, exportName: 'busyForever' }],
    communicationFailureOperationIds: ['test.busy-forever'],
    terminationUncertainOperationIds: ['test.busy-forever'],
    terminationAcknowledgeMs: acknowledgeMs,
  });

  const started = Date.now();
  const result = await adapter.act(request('ipc-cleanup-uncertain', 'uncertain'));
  const elapsed = Date.now() - started;

  assert.ok(elapsed >= acknowledgeMs - 20, `cleanup returned too early after ${elapsed}ms`);
  assert.equal(result.status, 'unknown');
  assert.equal(result.dispatch, 'unknown');
  assert.equal(result.verification, 'unverified');
  assert.deepEqual(result.evidence, ['compute-isolated-termination-uncertain']);
  assert.deepEqual((result.details as any).job.diagnostics, ['compute-isolated-termination-uncertain']);
});
