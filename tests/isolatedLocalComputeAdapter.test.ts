import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCAL_COMPUTE_CAPABILITY, LocalComputeAdapter, LOCAL_COMPUTE_EXECUTION_MODEL, type LocalComputeJson } from '../src/computer/localComputeAdapter.js';
import { IsolatedLocalComputeAdapter, ISOLATED_LOCAL_COMPUTE_EXECUTION_MODEL, type IsolatedLocalComputeOperationDefinition } from '../src/computer/isolatedLocalComputeAdapter.js';

const moduleUrl = new URL('./fixtures/isolatedLocalComputeOperations.js', import.meta.url).href;
const operations: IsolatedLocalComputeOperationDefinition[] = [
  { id: 'test.echo', effect: 'pure-read-only', moduleUrl, exportName: 'echo' },
  { id: 'test.large-output', effect: 'pure-read-only', moduleUrl, exportName: 'largeOutput' },
  { id: 'test.busy-forever', effect: 'pure-read-only', moduleUrl, exportName: 'busyForever' },
  { id: 'test.never-settles', effect: 'pure-read-only', moduleUrl, exportName: 'neverSettles' },
  { id: 'test.crash', effect: 'pure-read-only', moduleUrl, exportName: 'crash' },
  { id: 'test.artifact', effect: 'local-artifact-creation', moduleUrl, exportName: 'artifact' },
  { id: 'test.delayed', effect: 'local-artifact-creation', moduleUrl, exportName: 'delayedEcho' },
  { id: 'test.frozen-input', effect: 'pure-read-only', moduleUrl, exportName: 'frozenInput' },
];

function adapter(options: Partial<ConstructorParameters<typeof IsolatedLocalComputeAdapter>[0]> = {}): IsolatedLocalComputeAdapter {
  return new IsolatedLocalComputeAdapter({ id: 'compute-isolated-test', operations, terminationAcknowledgeMs: 2_000, ...options });
}

function request(jobId: string, generation: number, operation: string, input: LocalComputeJson, effect: 'observe-only' | 'local-reversible' = 'observe-only', idempotency: 'read-only' | 'non-idempotent' = 'read-only', limits?: object) {
  return { adapterId: 'compute-isolated-test', actionId: `action-${jobId}-${generation}`, capability: LOCAL_COMPUTE_CAPABILITY, effect, idempotency, payload: { job: { jobId, generation }, operation, input, limits } } as const;
}

test('cooperative local compute mode and claims remain unchanged', async () => {
  assert.equal(LOCAL_COMPUTE_EXECUTION_MODEL, 'trusted-in-process-cooperative');
  const cooperative = new LocalComputeAdapter({ id: 'cooperative-test', operations: [{ id: 'echo', effect: 'pure-read-only', execute: (input) => input }] });
  const result = await cooperative.act({ adapterId: 'cooperative-test', actionId: 'a', capability: LOCAL_COMPUTE_CAPABILITY, effect: 'observe-only', idempotency: 'read-only', payload: { job: { jobId: 'j', generation: 0 }, operation: 'echo', input: 'ok' } });
  assert.equal(result.status, 'completed');
});

test('isolated execution advertises a distinct enforceable timeout model', () => {
  assert.equal(ISOLATED_LOCAL_COMPUTE_EXECUTION_MODEL, 'isolated-child-process-enforceable-timeout');
  assert.notEqual(ISOLATED_LOCAL_COMPUTE_EXECUTION_MODEL, LOCAL_COMPUTE_EXECUTION_MODEL);
});

test('registered operation authority rejects command-shaped and unregistered requests before dispatch', async () => {
  const a = adapter();
  const command = await a.act({ ...request('command', 0, 'test.echo', null), payload: { job: { jobId: 'command', generation: 0 }, operation: 'test.echo', input: null, command: 'sh -c whoami' } } as any);
  assert.equal(command.dispatch, 'not-dispatched');
  assert.deepEqual(command.evidence, ['compute-isolated-request-invalid']);
  const missing = await a.act(request('missing', 0, 'test.not-registered', null));
  assert.equal(missing.dispatch, 'not-dispatched');
  assert.deepEqual(missing.evidence, ['compute-isolated-operation-unregistered']);
});

test('isolated adapter rejects non-file registered module schemes before worker launch', () => {
  assert.throws(() => new IsolatedLocalComputeAdapter({
    id: 'compute-isolated-test',
    operations: [{ id: 'test.node-builtin', effect: 'pure-read-only', moduleUrl: 'node:child_process', exportName: 'exec' }],
  }), /must use file: module URL/);
});

test('hard deadline terminates CPU-bound isolated work', async () => {
  const result = await adapter().act(request('busy', 0, 'test.busy-forever', null, 'observe-only', 'read-only', { timeBudgetMs: 250 }));
  assert.equal(result.status, 'failed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal((result.details as any).job.executionState, 'timed-out');
  assert.deepEqual(result.evidence, ['compute-isolated-timeout-terminated']);
});

test('hard deadline terminates an unresponsive never-settling operation', async () => {
  const result = await adapter().act(request('never', 0, 'test.never-settles', null, 'observe-only', 'read-only', { timeBudgetMs: 250 }));
  assert.equal(result.status, 'failed');
  assert.equal((result.details as any).job.executionState, 'timed-out');
  assert.deepEqual(result.evidence, ['compute-isolated-timeout-terminated']);
});

test('serialized input and output are bounded', async () => {
  const a = adapter();
  const input = await a.act(request('big-input', 0, 'test.echo', { pad: 'x'.repeat(1024) } as any, 'observe-only', 'read-only', { maxInputBytes: 32 }));
  assert.equal(input.dispatch, 'not-dispatched');
  assert.deepEqual(input.evidence, ['compute-isolated-input-limit']);
  const output = await a.act(request('big-output', 0, 'test.large-output', null, 'observe-only', 'read-only', { maxOutputBytes: 64 }));
  assert.equal(output.dispatch, 'dispatched-once');
  assert.deepEqual(output.evidence, ['compute-isolated-output-limit']);
});

test('worker crash is contained and sealed against replay', async () => {
  const a = adapter();
  const req = request('crash', 0, 'test.crash', null);
  const first = await a.act(req);
  assert.equal(first.status, 'failed');
  assert.equal(first.dispatch, 'dispatched-once');
  assert.deepEqual(first.evidence, ['compute-isolated-worker-crashed']);
  const replay = await a.act(req);
  assert.equal(replay.dispatch, 'dispatched-once');
  assert.deepEqual(replay.evidence, ['compute-isolated-known-failed']);
});

test('ambiguous launch never reopens a non-idempotent job', async () => {
  const a = adapter({ ambiguousLaunchOperationIds: ['test.artifact'] });
  const req = request('ambiguous', 0, 'test.artifact', 'value', 'local-reversible', 'non-idempotent');
  const first = await a.act(req);
  assert.equal(first.status, 'unknown');
  assert.equal(first.dispatch, 'unknown');
  const replay = await a.act(req);
  assert.equal(replay.status, 'unknown');
  assert.equal(replay.dispatch, 'unknown');
  assert.deepEqual(replay.evidence, ['compute-isolated-known-uncertain']);
});

test('artifact output is explicitly verified, generation-bound, and retrievable', async () => {
  const a = adapter();
  const result = await a.act(request('artifact', 7, 'test.artifact', { value: 3 }, 'local-reversible', 'non-idempotent'));
  assert.equal(result.status, 'completed');
  assert.equal(result.verification, 'verified');
  assert.deepEqual(result.evidence, ['compute-isolated-artifact-verified']);
  const ref = (result.details as any).artifact;
  assert.equal(ref.generation, 7);
  assert.match(ref.contentHash, /^sha256-[a-f0-9]{64}$/);
  assert.deepEqual(a.artifactContent(ref), { kind: 'artifact', input: { value: 3 } });
  assert.equal(a.artifactContent({ ...ref, byteLength: ref.byteLength + 1 }), undefined);
});

test('job/artifact detail retention is bounded while the dispatch ledger never evicts', async () => {
  const a = adapter({ maxRetainedJobs: 1, maxLedgerEntries: 2, maxArtifactStoreBytes: 32 });
  const firstReq = request('one', 0, 'test.artifact', '1234567890', 'local-reversible', 'non-idempotent');
  const first = await a.act(firstReq);
  await a.act(request('two', 0, 'test.echo', 'ok'));
  const replay = await a.act(firstReq);
  assert.equal(replay.dispatch, 'dispatched-once');
  assert.deepEqual(replay.evidence, ['compute-isolated-job-state-evicted']);
  const full = await a.act(request('three', 0, 'test.echo', 'nope'));
  assert.equal(full.dispatch, 'not-dispatched');
  assert.deepEqual(full.evidence, ['compute-isolated-ledger-full']);
  const ref = (first.details as any).artifact;
  assert.ok(ref);
});

test('concurrent generations use independent exactly-once identities', async () => {
  const a = adapter({ maxLedgerEntries: 4 });
  const generation0 = request('overlap', 0, 'test.delayed', 'slow', 'local-reversible', 'non-idempotent');
  const generation1 = request('overlap', 1, 'test.delayed', 'fast', 'local-reversible', 'non-idempotent');
  const pending0 = a.act(generation0);
  const pending1 = a.act(generation1);
  const [result0, result1] = await Promise.all([pending0, pending1]);
  assert.equal(result0.status, 'completed');
  assert.equal(result1.status, 'completed');
  assert.equal((result0.details as any).artifact.generation, 0);
  assert.equal((result1.details as any).artifact.generation, 1);
  assert.equal((await a.act(generation0)).dispatch, 'dispatched-once');
  assert.equal((await a.act(generation1)).dispatch, 'dispatched-once');
});

test('operation definitions and serialized input snapshots are immutable after acceptance', async () => {
  const mutable: IsolatedLocalComputeOperationDefinition = { id: 'test.mutable', effect: 'pure-read-only', moduleUrl, exportName: 'frozenInput' };
  const a = new IsolatedLocalComputeAdapter({ id: 'compute-isolated-test', operations: [mutable] });
  mutable.moduleUrl = 'file:///definitely/not/the/registered/module.js';
  mutable.exportName = 'missing';
  const input: any = { nested: { value: 1 } };
  const pending = a.act(request('snapshot', 0, 'test.mutable', input));
  input.nested.value = 99;
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.deepEqual((result.details as any).output, { nested: { value: 1 } });
});
