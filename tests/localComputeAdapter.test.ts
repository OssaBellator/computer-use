import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalComputeAdapter, LOCAL_COMPUTE_CAPABILITY, LOCAL_COMPUTE_EXECUTION_MODEL, localComputeJobEntity, type LocalComputeJson } from '../src/computer/localComputeAdapter.js';

const operations = [
  { id: 'math.add', effect: 'pure-read-only' as const, execute: (input: LocalComputeJson) => { const v = input as { a: number; b: number }; return { sum: v.a + v.b }; } },
  { id: 'stats.mean', effect: 'pure-read-only' as const, execute: (input: LocalComputeJson) => { const v = input as number[]; return { mean: v.reduce((a, b) => a + b, 0) / v.length, count: v.length }; } },
  { id: 'transform.upper', effect: 'local-artifact-creation' as const, execute: (input: LocalComputeJson) => String(input).toUpperCase() },
  { id: 'test.timeout', effect: 'pure-read-only' as const, execute: (_input: LocalComputeJson, ctx: { signal: AbortSignal }) => new Promise<LocalComputeJson>((resolve, reject) => { ctx.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); setTimeout(() => resolve('late'), 100); }) },
  { id: 'test.ignore-abort', effect: 'pure-read-only' as const, execute: () => new Promise<LocalComputeJson>((resolve) => setTimeout(() => resolve('late'), 50)) },
  { id: 'test.cpu-bound', effect: 'pure-read-only' as const, execute: () => { const until = performance.now() + 20; while (performance.now() < until) { /* synthetic bounded busy loop */ } return 'done'; } },
  { id: 'test.large', effect: 'pure-read-only' as const, execute: () => 'x'.repeat(2048) },
  { id: 'test.invalid-output', effect: 'pure-read-only' as const, execute: (() => new Date()) as any },
  { id: 'test.slow-artifact', effect: 'local-artifact-creation' as const, execute: async (input: LocalComputeJson) => { await new Promise((resolve) => setTimeout(resolve, 20)); return input; } },
];
function adapter(ambiguous: string[] = [], options: { maxRetainedJobs?: number; maxRetainedJobIds?: number; maxArtifactStoreBytes?: number } = {}) {
  return new LocalComputeAdapter({ id: 'compute-test', operations, ambiguousDispatchOperationIds: ambiguous, ...options });
}
function request(jobId: string, generation: number, operation: string, input: LocalComputeJson, effect: 'observe-only' | 'local-reversible' = 'observe-only', idempotency: 'read-only' | 'non-idempotent' = 'read-only', limits?: object) {
  return { adapterId: 'compute-test', actionId: `action-${jobId}-${generation}`, capability: LOCAL_COMPUTE_CAPABILITY, effect, idempotency, payload: { job: { jobId, generation }, operation, input, limits } } as const;
}

test('arithmetic and statistics verify SHA-256 bounded output identity', async () => {
  const a = adapter();
  const sum = await a.act(request('sum', 0, 'math.add', { a: 2, b: 5 }));
  assert.equal(sum.status, 'completed'); assert.equal(sum.verification, 'verified'); assert.deepEqual((sum.details as any).output, { sum: 7 });
  const mean = await a.act(request('mean', 0, 'stats.mean', [2, 4, 6])); assert.deepEqual((mean.details as any).output, { mean: 4, count: 3 });
  assert.match((mean.details as any).job.outputArtifact.contentHash, /^sha256-[a-f0-9]{64}$/); assert.equal((mean.details as any).job.outputArtifact.shape, 'object:2');
});

test('bounded artifact transformation verifies artifact identity and state', async () => {
  const a = adapter(); const result = await a.act(request('upper', 0, 'transform.upper', 'secret text', 'local-reversible', 'non-idempotent'));
  assert.equal(result.status, 'completed'); assert.deepEqual(result.evidence, ['compute-artifact-verified']);
  const ref = (result.details as any).artifact; assert.equal(ref.state, 'committed'); assert.equal(a.artifactContent(ref), 'SECRET TEXT');
});

test('cooperative timeout is explicit for abort-aware and ignored-abort operations', async () => {
  const aware = await adapter().act(request('timeout', 0, 'test.timeout', null, 'observe-only', 'read-only', { timeBudgetMs: 5 }));
  assert.equal(aware.status, 'failed'); assert.equal(aware.dispatch, 'dispatched-once'); assert.equal((aware.details as any).job.executionState, 'timed-out'); assert.deepEqual(aware.evidence, ['compute-cooperative-timeout']);
  const ignored = await adapter().act(request('ignored', 0, 'test.ignore-abort', null, 'observe-only', 'read-only', { timeBudgetMs: 5 }));
  assert.equal(ignored.status, 'failed'); assert.equal(ignored.dispatch, 'dispatched-once'); assert.deepEqual(ignored.evidence, ['compute-cooperative-timeout']);
});

test('CPU-bound synchronous overrun is detected after the registered operation returns', async () => {
  const result = await adapter().act(request('cpu', 0, 'test.cpu-bound', null, 'observe-only', 'read-only', { timeBudgetMs: 5 }));
  assert.equal(result.status, 'failed'); assert.equal(result.dispatch, 'dispatched-once'); assert.deepEqual(result.evidence, ['compute-cooperative-timeout']);
});

test('output and input limits are bounded', async () => {
  const a = adapter();
  const output = await a.act(request('large', 0, 'test.large', null, 'observe-only', 'read-only', { maxOutputBytes: 32 })); assert.deepEqual(output.evidence, ['compute-output-limit']);
  const input = await a.act(request('input', 0, 'math.add', { a: 1, b: 2, pad: 'x'.repeat(100) } as any, 'observe-only', 'read-only', { maxInputBytes: 16 })); assert.equal(input.dispatch, 'not-dispatched'); assert.deepEqual(input.evidence, ['compute-input-limit']);
});

test('runtime JSON validation rejects non-plain/accessor/deep inputs and invalid outputs', async () => {
  const a = adapter();
  const date = await a.act(request('date', 0, 'math.add', new Date() as any)); assert.deepEqual(date.evidence, ['compute-input-invalid']);
  let getterCalled = false;
  const accessor: Record<string, unknown> = {}; Object.defineProperty(accessor, 'a', { enumerable: true, get() { getterCalled = true; return 1; } });
  const getter = await a.act(request('getter', 0, 'math.add', accessor as any)); assert.deepEqual(getter.evidence, ['compute-input-invalid']); assert.equal(getterCalled, false);
  const deep = { a: { b: { c: 1 } } } as any;
  const depth = await a.act(request('depth', 0, 'math.add', deep, 'observe-only', 'read-only', { maxJsonDepth: 1 })); assert.deepEqual(depth.evidence, ['compute-input-invalid']);
  const invalidOutput = await a.act(request('bad-output', 0, 'test.invalid-output', null)); assert.equal(invalidOutput.dispatch, 'dispatched-once'); assert.deepEqual(invalidOutput.evidence, ['compute-execution-failed']);
});

test('stale identity and mismatched action target are rejected before dispatch', async () => {
  const a = adapter(); await a.act(request('reuse', 2, 'math.add', { a: 1, b: 1 }));
  const stale = await a.act(request('reuse', 1, 'math.add', { a: 1, b: 1 })); assert.equal(stale.dispatch, 'not-dispatched'); assert.deepEqual(stale.evidence, ['compute-job-stale']);
  const mismatch = await a.act({ ...request('targeted', 2, 'math.add', { a: 1, b: 1 }), target: localComputeJobEntity('compute-test', { jobId: 'targeted', generation: 1 }) });
  assert.equal(mismatch.dispatch, 'not-dispatched'); assert.deepEqual(mismatch.evidence, ['compute-target-mismatch']);
});

test('definite pre-dispatch validation failure is not dispatched', async () => {
  const bad = await adapter().act({ ...request('bad', 0, 'math.add', { a: 1, b: 2 }), payload: { job: { jobId: 'bad', generation: 0 }, operation: 'math.add', input: { a: 1, b: 2 }, command: 'sh -c whoami' } } as any);
  assert.equal(bad.dispatch, 'not-dispatched'); assert.deepEqual(bad.evidence, ['compute-request-invalid']);
});

test('ambiguous dispatch becomes unknown and artifact job is not retried', async () => {
  const a = adapter(['transform.upper']); const req = request('ambiguous', 0, 'transform.upper', 'value', 'local-reversible', 'non-idempotent');
  const first = await a.act(req); assert.equal(first.dispatch, 'unknown'); assert.equal(first.status, 'unknown');
  const second = await a.act(req); assert.equal(second.dispatch, 'unknown'); assert.deepEqual(second.evidence, ['compute-known-dispatch-unknown']); assert.equal((second.details as any).job.executionState, 'unknown');
});

test('known failed and timed-out jobs preserve dispatched-once on replay', async () => {
  const a = adapter(); const req = request('replay-timeout', 0, 'test.timeout', null, 'observe-only', 'read-only', { timeBudgetMs: 5 });
  const first = await a.act(req); assert.equal(first.dispatch, 'dispatched-once');
  const replay = await a.act(req); assert.equal(replay.status, 'failed'); assert.equal(replay.dispatch, 'dispatched-once'); assert.deepEqual(replay.evidence, ['compute-known-job-failed']);
});

test('retention budgets bound detail/artifact state while execution ledger fails closed', async () => {
  const a = adapter([], { maxRetainedJobs: 1, maxRetainedJobIds: 2, maxArtifactStoreBytes: 12 });
  const first = await a.act(request('one', 0, 'transform.upper', '123456', 'local-reversible', 'non-idempotent')); const firstRef = (first.details as any).artifact;
  await a.act(request('two', 0, 'transform.upper', 'abcdef', 'local-reversible', 'non-idempotent'));
  assert.equal(a.artifactContent(firstRef), undefined);
  const observed = await a.observe({ adapterId: 'compute-test', channel: 'compute', target: localComputeJobEntity('compute-test', { jobId: 'one', generation: 0 }) }); assert.equal(observed.data, null);
  const replay = await a.act(request('one', 0, 'transform.upper', '123456', 'local-reversible', 'non-idempotent'));
  assert.equal(replay.dispatch, 'dispatched-once'); assert.deepEqual(replay.evidence, ['compute-job-state-evicted']);
  const full = await a.act(request('three', 0, 'math.add', { a: 1, b: 2 })); assert.equal(full.dispatch, 'not-dispatched'); assert.deepEqual(full.evidence, ['compute-execution-ledger-full']);
});

test('in-flight detail eviction cannot cause non-idempotent redispatch', async () => {
  const a = adapter([], { maxRetainedJobs: 1, maxRetainedJobIds: 2 });
  const slowReq = request('slow', 0, 'test.slow-artifact', 'value', 'local-reversible', 'non-idempotent');
  const pending = a.act(slowReq);
  await new Promise((resolve) => setTimeout(resolve, 1));
  await a.act(request('other', 0, 'math.add', { a: 1, b: 2 }));
  const replay = await a.act(slowReq);
  assert.equal(replay.dispatch, 'dispatched-once'); assert.deepEqual(replay.evidence, ['compute-job-state-evicted']);
  assert.equal((await pending).status, 'completed');
});

test('observation and evidence do not copy sensitive input/output', async () => {
  const a = adapter(); const secret = 'MODEL_INPUT_DO_NOT_TRACE'; const result = await a.act(request('privacy', 0, 'transform.upper', secret, 'local-reversible', 'non-idempotent'));
  assert.ok(!JSON.stringify(result.evidence).includes(secret));
  const observed = await a.observe({ adapterId: 'compute-test', channel: 'compute', target: localComputeJobEntity('compute-test', { jobId: 'privacy', generation: 0 }) });
  const trace = JSON.stringify(observed); assert.ok(!trace.includes(secret)); assert.ok(!trace.includes(secret.toUpperCase())); assert.match(trace, /artifact:sha256-/);
});

test('operation registration snapshots authority and function reference', async () => {
  const mutable: any = { id: 'mutable.op', effect: 'pure-read-only', execute: () => 'original' };
  const a = new LocalComputeAdapter({ id: 'compute-test', operations: [mutable] });
  mutable.effect = 'process-execution'; mutable.execute = () => 'mutated';
  const result = await a.act(request('mutable', 0, 'mutable.op', null));
  assert.equal(result.status, 'completed'); assert.equal((result.details as any).output, 'original');
});

test('execution uses immutable validated input snapshot', async () => {
  const op = { id: 'snapshot.input', effect: 'pure-read-only' as const, execute: async (input: LocalComputeJson) => { await Promise.resolve(); return input; } };
  const a = new LocalComputeAdapter({ id: 'compute-test', operations: [op] });
  const input: any = { nested: { value: 1 } };
  const pending = a.act(request('snapshot', 0, 'snapshot.input', input));
  input.nested.value = 99;
  const result = await pending;
  assert.deepEqual((result.details as any).output, { nested: { value: 1 } });
});

test('artifact store owns canonical immutable content snapshot', async () => {
  let retained: any;
  const op = { id: 'snapshot.output', effect: 'local-artifact-creation' as const, execute: () => (retained = { nested: { value: 1 } }) };
  const a = new LocalComputeAdapter({ id: 'compute-test', operations: [op] });
  const result = await a.act(request('artifact-snapshot', 0, 'snapshot.output', null, 'local-reversible', 'non-idempotent'));
  const ref = (result.details as any).artifact; retained.nested.value = 99;
  const first = a.artifactContent(ref) as any; assert.deepEqual(first, { nested: { value: 1 } });
  assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.nested));
});

test('public execution model is trusted in-process cooperative, not hard isolation', () => {
  assert.equal(LOCAL_COMPUTE_EXECUTION_MODEL, 'trusted-in-process-cooperative');
});

test('unsafe operation registrations and shell-like masquerading are rejected', async () => {
  assert.throws(() => new LocalComputeAdapter({ operations: [{ id: 'unsafe.shell', effect: 'process-execution', execute: () => null }] }), /unsafe local compute operation effect/);
  const misuse = await adapter().act(request('shell', 0, 'sh -c id', null)); assert.equal(misuse.dispatch, 'not-dispatched'); assert.deepEqual(misuse.evidence, ['compute-request-invalid']);
});
