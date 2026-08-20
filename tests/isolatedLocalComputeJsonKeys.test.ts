import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_COMPUTE_CAPABILITY } from '../src/computer/localComputeAdapter.js';
import { IsolatedLocalComputeAdapter } from '../src/computer/isolatedLocalComputeAdapter.js';

const moduleUrl = new URL('./fixtures/isolatedLocalComputeOperations.js', import.meta.url).href;

function adapter(): IsolatedLocalComputeAdapter {
  return new IsolatedLocalComputeAdapter({
    id: 'json-keys-test',
    operations: [
      { id: 'test.echo', effect: 'pure-read-only', moduleUrl, exportName: 'echo' },
      { id: 'test.symbol-output', effect: 'pure-read-only', moduleUrl, exportName: 'symbolOutput' },
    ],
  });
}

function request(jobId: string, operation: string, input: unknown) {
  return {
    adapterId: 'json-keys-test',
    actionId: `action-${jobId}`,
    capability: LOCAL_COMPUTE_CAPABILITY,
    effect: 'observe-only',
    idempotency: 'read-only',
    payload: { job: { jobId, generation: 0 }, operation, input },
  } as const;
}

test('symbol-keyed input is rejected rather than silently omitted from the immutable snapshot', async () => {
  const input: Record<PropertyKey, unknown> = { visible: true };
  input[Symbol('hidden')] = 'must-not-be-dropped';
  const result = await adapter().act(request('symbol-input', 'test.echo', input) as any);
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.deepEqual(result.evidence, ['compute-isolated-input-invalid']);
});

test('symbol-keyed worker output is rejected rather than silently verified as JSON', async () => {
  const result = await adapter().act(request('symbol-output', 'test.symbol-output', null));
  assert.equal(result.status, 'failed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(result.verification, 'rejected');
  assert.deepEqual(result.evidence, ['compute-isolated-execution-failed']);
});
