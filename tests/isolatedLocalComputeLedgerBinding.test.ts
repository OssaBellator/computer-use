import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_COMPUTE_CAPABILITY } from '../src/computer/localComputeAdapter.js';
import { IsolatedLocalComputeAdapter } from '../src/computer/isolatedLocalComputeAdapter.js';

const moduleUrl = new URL('./fixtures/isolatedLocalComputeOperations.js', import.meta.url).href;

function request(input: string) {
  return {
    adapterId: 'ledger-binding-test',
    actionId: `action-${input}`,
    capability: LOCAL_COMPUTE_CAPABILITY,
    effect: 'local-reversible',
    idempotency: 'non-idempotent',
    payload: {
      job: { jobId: 'bound-job', generation: 0 },
      operation: 'test.artifact',
      input,
    },
  } as const;
}

test('non-evicted ledger binding rejects a conflicting payload after job detail eviction', async () => {
  const adapter = new IsolatedLocalComputeAdapter({
    id: 'ledger-binding-test',
    operations: [
      { id: 'test.artifact', effect: 'local-artifact-creation', moduleUrl, exportName: 'artifact' },
      { id: 'test.echo', effect: 'pure-read-only', moduleUrl, exportName: 'echo' },
    ],
    maxRetainedJobs: 1,
    maxLedgerEntries: 3,
  });

  const original = request('original');
  const first = await adapter.act(original);
  assert.equal(first.status, 'completed');
  assert.equal(first.dispatch, 'dispatched-once');

  await adapter.act({
    adapterId: 'ledger-binding-test',
    actionId: 'evict-detail',
    capability: LOCAL_COMPUTE_CAPABILITY,
    effect: 'observe-only',
    idempotency: 'read-only',
    payload: {
      job: { jobId: 'other-job', generation: 0 },
      operation: 'test.echo',
      input: 'evict',
    },
  });

  const conflicting = await adapter.act(request('different'));
  assert.equal(conflicting.status, 'rejected');
  assert.equal(conflicting.dispatch, 'not-dispatched');
  assert.deepEqual(conflicting.evidence, ['compute-isolated-job-identity-conflict']);

  const replay = await adapter.act(original);
  assert.equal(replay.status, 'completed');
  assert.equal(replay.dispatch, 'dispatched-once');
  assert.equal(replay.verification, 'unverified');
  assert.deepEqual(replay.evidence, ['compute-isolated-job-state-evicted']);
});
