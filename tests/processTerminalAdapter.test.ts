import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { computerActionMayAutoRetry } from '../src/computer/environmentAdapter.js';
import {
  HostProcessAdapter,
  ProcessIdentityStore,
  type ProcessRecord,
  type ProcessSnapshotSource,
} from '../src/computer/processAdapter.js';
import {
  HostTerminalAdapter,
  type ExecutionPathBinder,
  type ExecutionPathIdentity,
  type ProcessSpawner,
  type SpawnedProcessLike,
  type TerminalExecutionDetails,
  type TerminalExecutionEffectResolver,
} from '../src/computer/terminalAdapter.js';

class FakeProcessSource implements ProcessSnapshotSource {
  pids = [10, 11, 12];
  records = new Map<number, ProcessRecord>([
    [10, { pid: 10, startTicks: 100, name: 'a'.repeat(300), executable: 'alpha-bin', state: 'running', rssBytes: 10 }],
    [11, { pid: 11, startTicks: 110, name: 'beta', executable: 'beta-bin', state: 'sleeping', rssBytes: 20 }],
    [12, { pid: 12, startTicks: 120, name: 'gamma', executable: 'gamma-bin', state: 'waiting', rssBytes: 30 }],
  ]);
  async listPids(): Promise<{ pids: readonly number[]; truncated: boolean }> { return { pids: this.pids, truncated: false }; }
  async inspect(pid: number): Promise<ProcessRecord | undefined> { return this.records.get(pid); }
}

function argvRequest(cwd: string, overrides: Record<string, unknown> = {}) {
  return {
    adapterId: 'terminal:test',
    actionId: 'run-1',
    capability: 'terminal.execute.argv',
    effect: 'security-sensitive' as const,
    idempotency: 'non-idempotent' as const,
    payload: {
      mode: 'argv' as const,
      executable: process.execPath,
      argv: ['-e', 'process.stdout.write("ok")'],
      cwd,
      classification: 'local-compute' as const,
      ...overrides,
    },
  };
}

class FakeChild extends EventEmitter implements SpawnedProcessLike {
  pid: number | undefined = 424242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  constructor(private readonly killResult = true) { super(); }
  kill(): boolean { return this.killResult; }
}

function identity(kind: 'file' | 'directory', path: string, overrides: Partial<ExecutionPathIdentity> = {}): ExecutionPathIdentity {
  return {
    realPath: path,
    kind,
    dev: '1',
    ino: kind === 'file' ? '10' : '20',
    mode: kind === 'file' ? '33261' : '16877',
    birthtimeNs: '1',
    ctimeNs: '2',
    ...(kind === 'file' ? { size: '10', mtimeNs: '3' } : {}),
    ...overrides,
  };
}

function stableBinder(): ExecutionPathBinder {
  return { async bind(path, kind) { return identity(kind, path); } };
}

function closingSpawner(calls?: Array<{ executable: string; argv: readonly string[]; options: any }>): ProcessSpawner {
  return {
    spawn(executable, argv, options) {
      calls?.push({ executable, argv: [...argv], options });
      const child = new FakeChild();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    },
  };
}

test('process observation is bounded and omits command lines/environment', async () => {
  const adapter = new HostProcessAdapter(new ProcessIdentityStore('process:test', new FakeProcessSource()));
  const observation = await adapter.observe({ adapterId: 'process:test', channel: 'process', limits: { maxItems: 2 } });
  assert.equal(observation.truncated, true);
  const data = observation.data as { processes: Array<Record<string, unknown>> };
  assert.equal(data.processes.length, 2);
  assert.ok(Buffer.byteLength(String(data.processes[0]?.name)) <= 160);
  assert.equal('commandLine' in data.processes[0]!, false);
  assert.equal('env' in data.processes[0]!, false);
});

test('process observation honors total text budget deterministically', async () => {
  const adapter = new HostProcessAdapter(new ProcessIdentityStore('process:test', new FakeProcessSource()));
  const observation = await adapter.observe({ adapterId: 'process:test', channel: 'process', limits: { maxItems: 3, maxTextBytes: 12 } });
  const data = observation.data as { processes: Array<{ name: string; executable?: string }> };
  const total = data.processes.reduce((sum, item) => sum + Buffer.byteLength(item.name) + Buffer.byteLength(item.executable ?? ''), 0);
  assert.ok(total <= 12);
  assert.equal(observation.truncated, true);
});

test('process target detects PID generation replacement', async () => {
  const source = new FakeProcessSource();
  const identities = new ProcessIdentityStore('process:test', source);
  const adapter = new HostProcessAdapter(identities);
  const first = await identities.inspect(10);
  if (!first) throw new Error('expected fixture process');
  source.records.set(10, { pid: 10, startTicks: 999, name: 'replacement', state: 'running' });
  const observation = await adapter.observe({ adapterId: 'process:test', channel: 'process', target: first.ref });
  assert.equal((observation.data as { identity: string }).identity, 'replaced');
});

test('arbitrary executable cannot self-declare local-compute to obtain process-execution', async () => {
  let calls = 0;
  const spawner: ProcessSpawner = { spawn() { calls += 1; return new FakeChild(); } };
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner, stableBinder());
  const result = await adapter.act({
    adapterId: 'terminal:test', actionId: 'destructive-fixture', capability: 'terminal.execute.argv',
    effect: 'process-execution', idempotency: 'non-idempotent',
    payload: {
      mode: 'argv', executable: '/fixture/destructive-tool', argv: ['--delete-all'], cwd: '/fixture', classification: 'local-compute',
    },
  });
  assert.equal(result.dispatch, 'not-dispatched');
  assert.deepEqual(result.evidence, ['terminal.effect.mismatch']);
  assert.equal(calls, 0);
});

test('trusted effect resolver may authorize a known operation as process-execution', async () => {
  const calls: Array<{ executable: string; argv: readonly string[]; options: any }> = [];
  const resolver: TerminalExecutionEffectResolver = {
    requiredEffect(payload) {
      return payload.mode === 'argv' && payload.executable === '/fixture/known-tool' && payload.argv[0] === '--version'
        ? 'process-execution' : undefined;
    },
  };
  const adapter = new HostTerminalAdapter(
    'terminal:test', new ProcessIdentityStore('process:test', new FakeProcessSource()), closingSpawner(calls), stableBinder(), resolver,
  );
  const result = await adapter.act({
    adapterId: 'terminal:test', actionId: 'known', capability: 'terminal.execute.argv', effect: 'process-execution', idempotency: 'non-idempotent',
    payload: { mode: 'argv', executable: '/fixture/known-tool', argv: ['--version'], cwd: '/fixture', classification: 'local-compute' },
  });
  assert.equal(result.status, 'completed');
  assert.equal(result.verification, 'verified');
  assert.equal(calls.length, 1);
});

test('payload is immutable-snapshotted before path preflight awaits', async () => {
  const cwd = '/fixture/original';
  const payload = {
    mode: 'argv' as const,
    executable: '/fixture/tool',
    argv: ['original'],
    cwd,
    env: { SAFE: 'original' },
    timeoutMs: 1000,
    maxOutputBytes: 128,
    classification: 'local-compute' as const,
  };
  const calls: Array<{ executable: string; argv: readonly string[]; options: any }> = [];
  let bindCalls = 0;
  const binder: ExecutionPathBinder = {
    async bind(path, kind) {
      bindCalls += 1;
      if (bindCalls === 1) {
        payload.argv[0] = 'mutated';
        payload.cwd = '/fixture/mutated';
        payload.env.SAFE = 'mutated';
        payload.timeoutMs = 30000;
        payload.maxOutputBytes = 999999;
        payload.classification = 'remote-execution' as any;
      }
      return identity(kind, path);
    },
  };
  const adapter = new HostTerminalAdapter(
    'terminal:test', new ProcessIdentityStore('process:test', new FakeProcessSource()), closingSpawner(calls), binder,
  );
  const result = await adapter.act({
    adapterId: 'terminal:test', actionId: 'snapshot', capability: 'terminal.execute.argv', effect: 'security-sensitive', idempotency: 'non-idempotent', payload,
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls[0]?.argv, ['original']);
  assert.equal(calls[0]?.options.cwd, cwd);
  assert.deepEqual(calls[0]?.options.env, { SAFE: 'original' });
});

test('ctime identity replacement before invocation fails closed', async () => {
  let fileBind = 0;
  let calls = 0;
  const binder: ExecutionPathBinder = {
    async bind(path, kind) {
      if (kind === 'file') return identity(kind, path, { ctimeNs: String(++fileBind) });
      return identity(kind, path);
    },
  };
  const spawner: ProcessSpawner = { spawn() { calls += 1; return new FakeChild(); } };
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner, binder);
  const result = await adapter.act(argvRequest('/fixture'));
  assert.equal(result.dispatch, 'not-dispatched');
  assert.deepEqual(result.evidence, ['terminal.executable.replaced']);
  assert.equal(calls, 0);
});

test('argv execution preserves arguments and cwd without shell interpolation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'));
    const result = await adapter.act(argvRequest(cwd, {
      argv: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', 'a b', '$(not-a-command)', 'semi;colon'],
    }));
    assert.equal(result.status, 'completed');
    assert.deepEqual(JSON.parse((result.details as TerminalExecutionDetails).stdout), ['a b', '$(not-a-command)', 'semi;colon']);
    const cwdResult = await adapter.act(argvRequest(cwd, { argv: ['-e', 'process.stdout.write(process.cwd())'] }));
    assert.equal((cwdResult.details as TerminalExecutionDetails).stdout, cwd);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('stdout and stderr capture are independently bounded', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'));
    const result = await adapter.act(argvRequest(cwd, { argv: ['-e', 'process.stdout.write("o".repeat(200));process.stderr.write("e".repeat(200))'], maxOutputBytes: 32 }));
    const details = result.details as TerminalExecutionDetails;
    assert.equal(Buffer.byteLength(details.stdout), 32);
    assert.equal(Buffer.byteLength(details.stderr), 32);
    assert.equal(details.stdoutTruncated, true);
    assert.equal(details.stderrTruncated, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('timeout is dispatched once and reports process timeout without domain verification', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'));
    const result = await adapter.act(argvRequest(cwd, { argv: ['-e', 'setInterval(() => {}, 1000)'], timeoutMs: 50 }));
    assert.equal(result.status, 'failed');
    assert.equal(result.dispatch, 'dispatched-once');
    assert.equal(result.verification, 'not-applicable');
    assert.deepEqual(result.evidence, ['terminal.execution.timeout-domain-unverified']);
    assert.equal((result.details as TerminalExecutionDetails).timedOut, true);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('timeout kill=false is bounded cleanup ambiguity', async () => {
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), { spawn() { return new FakeChild(false); } }, stableBinder());
  const result = await adapter.act(argvRequest('/fixture', { timeoutMs: 20 }));
  assert.equal(result.status, 'unknown');
  assert.deepEqual(result.evidence, ['terminal.timeout.cleanup-ambiguous']);
});

test('timeout missing close is bounded by cleanup deadline', async () => {
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), { spawn() { return new FakeChild(true); } }, stableBinder());
  const started = Date.now();
  const result = await adapter.act(argvRequest('/fixture', { timeoutMs: 20 }));
  assert.ok(Date.now() - started < 600);
  assert.equal(result.status, 'unknown');
});

test('definite prelaunch path failure is not dispatched', async () => {
  let calls = 0;
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), { spawn() { calls += 1; return new FakeChild(); } }, { async bind() { return undefined; } });
  const result = await adapter.act(argvRequest('/fixture'));
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(calls, 0);
});

test('executable identity replacement before invocation fails closed', async () => {
  let fileBind = 0;
  let calls = 0;
  const binder: ExecutionPathBinder = { async bind(path, kind) { return identity(kind, path, kind === 'file' ? { ino: String(++fileBind) } : {}); } };
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), { spawn() { calls += 1; return new FakeChild(); } }, binder);
  const result = await adapter.act(argvRequest('/fixture'));
  assert.deepEqual(result.evidence, ['terminal.executable.replaced']);
  assert.equal(calls, 0);
});

test('cwd identity replacement before invocation fails closed', async () => {
  let dirBind = 0;
  let calls = 0;
  const binder: ExecutionPathBinder = { async bind(path, kind) { return identity(kind, path, kind === 'directory' ? { ino: String(++dirBind) } : {}); } };
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), { spawn() { calls += 1; return new FakeChild(); } }, binder);
  const result = await adapter.act(argvRequest('/fixture'));
  assert.deepEqual(result.evidence, ['terminal.cwd.replaced']);
  assert.equal(calls, 0);
});

test('throw after invocation is dispatch unknown and not auto-retry eligible', async () => {
  const request = argvRequest('/fixture');
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), { spawn() { throw new Error('ambiguous'); } }, stableBinder());
  const result = await adapter.act(request);
  assert.equal(result.dispatch, 'unknown');
  assert.equal(computerActionMayAutoRetry(request, result), false);
});

test('argv and shell are separate capabilities and shell stays explicit', async () => {
  const calls: Array<{ executable: string; argv: readonly string[]; options: any }> = [];
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test', new FakeProcessSource()), closingSpawner(calls), stableBinder());
  const argvResult = await adapter.act(argvRequest('/fixture', { argv: ['literal;argument'] }));
  assert.equal(argvResult.status, 'completed');
  assert.equal(argvResult.verification, 'not-applicable');
  assert.equal(calls[0]?.options.shell, false);
  const shellResult = await adapter.act({
    adapterId: 'terminal:test', actionId: 'shell', capability: 'terminal.execute.shell', effect: 'security-sensitive', idempotency: 'non-idempotent',
    payload: { mode: 'shell', shellExecutable: '/fixture/shell', shellArgs: ['-c'], command: 'echo x', cwd: '/fixture', classification: 'local-compute' },
  });
  assert.equal(shellResult.status, 'completed');
  assert.equal(shellResult.verification, 'not-applicable');
  assert.deepEqual(calls[1]?.argv, ['-c', 'echo x']);
  assert.equal(calls[1]?.options.shell, false);
});

test('shell argv plus command aggregate bytes are bounded', async () => {
  let calls = 0;
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), { spawn() { calls += 1; return new FakeChild(); } }, stableBinder());
  const result = await adapter.act({
    adapterId: 'terminal:test', actionId: 'shell-large', capability: 'terminal.execute.shell', effect: 'security-sensitive', idempotency: 'non-idempotent',
    payload: { mode: 'shell', shellExecutable: '/fixture/shell', shellArgs: Array(9).fill('x'.repeat(4000)), command: 'echo', cwd: '/fixture', classification: 'local-compute' },
  });
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(calls, 0);
});

test('non-zero exit under stronger effect is process failure but domain unverified', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'));
    const result = await adapter.act(argvRequest(cwd, { argv: ['-e', 'process.exit(7)'] }));
    assert.equal(result.status, 'failed');
    assert.equal(result.verification, 'not-applicable');
    assert.deepEqual(result.evidence, ['terminal.execution.nonzero-exit-domain-unverified']);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('generic evidence never contains command output or secrets', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const secret = 'token-super-secret-value';
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'));
    const result = await adapter.act(argvRequest(cwd, { argv: ['-e', `process.stdout.write(${JSON.stringify(secret)});process.stderr.write(${JSON.stringify(secret)})`] }));
    assert.equal(JSON.stringify(result.evidence ?? []).includes(secret), false);
    assert.equal((result.details as TerminalExecutionDetails).stdout, secret);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test('unacknowledged returned child stays dispatch unknown', async () => {
  const spawner: ProcessSpawner = { spawn() { const child = new FakeChild(); child.pid = undefined; return child; } };
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner, stableBinder());
  const result = await adapter.act(argvRequest('/fixture'));
  assert.equal(result.dispatch, 'unknown');
});

test('terminal observation validates generation-aware session identity', async () => {
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'));
  const observation = await adapter.observe({ adapterId: 'terminal:test', channel: 'terminal' });
  const session = (observation.data as { session: any }).session;
  assert.equal(session.generation, 0);
  const stale = await adapter.observe({ adapterId: 'terminal:test', channel: 'terminal', target: { ...session, generation: 1 } });
  assert.equal(stale.complete, false);
  assert.deepEqual(stale.data, { code: 'terminal.session.stale' });
});
