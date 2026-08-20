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
} from '../src/computer/terminalAdapter.js';

class FakeProcessSource implements ProcessSnapshotSource {
  pids = [10, 11, 12];
  records = new Map<number, ProcessRecord>([
    [10, { pid: 10, startTicks: 100, name: 'a'.repeat(300), executable: 'alpha-bin', state: 'running', rssBytes: 10 }],
    [11, { pid: 11, startTicks: 110, name: 'beta', executable: 'beta-bin', state: 'sleeping', rssBytes: 20 }],
    [12, { pid: 12, startTicks: 120, name: 'gamma', executable: 'gamma-bin', state: 'waiting', rssBytes: 30 }],
  ]);
  async listPids(): Promise<readonly number[]> { return this.pids; }
  async inspect(pid: number): Promise<ProcessRecord | undefined> { return this.records.get(pid); }
}

function argvRequest(cwd: string, overrides: Record<string, unknown> = {}) {
  return {
    adapterId: 'terminal:test',
    actionId: 'run-1',
    capability: 'terminal.execute.argv',
    effect: 'process-execution' as const,
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

test('process observation is bounded and metadata excludes command lines/environment', async () => {
  const source = new FakeProcessSource();
  const adapter = new HostProcessAdapter(new ProcessIdentityStore('process:test', source));
  const observation = await adapter.observe({ adapterId: 'process:test', channel: 'process', limits: { maxItems: 2 } });
  assert.equal(observation.truncated, true);
  const data = observation.data as { processes: Array<Record<string, unknown>> };
  assert.equal(data.processes.length, 2);
  assert.ok(Buffer.byteLength(String(data.processes[0]?.name), 'utf8') <= 160);
  assert.equal('commandLine' in data.processes[0]!, false);
  assert.equal('env' in data.processes[0]!, false);
});

test('process observation honors total text budget deterministically', async () => {
  const source = new FakeProcessSource();
  const adapter = new HostProcessAdapter(new ProcessIdentityStore('process:test', source));
  const observation = await adapter.observe({
    adapterId: 'process:test',
    channel: 'process',
    limits: { maxItems: 3, maxTextBytes: 12 },
  });
  const data = observation.data as { processes: Array<{ name: string; executable?: string }> };
  const textBytes = data.processes.reduce(
    (sum, item) => sum + Buffer.byteLength(item.name) + Buffer.byteLength(item.executable ?? ''),
    0,
  );
  assert.ok(textBytes <= 12);
  assert.equal(observation.truncated, true);
  assert.equal(data.processes[0]?.name, 'a'.repeat(12));
  assert.equal(data.processes[0]?.executable, undefined);
  assert.equal(data.processes[1]?.name, '');
});

test('process target detects PID generation replacement', async () => {
  const source = new FakeProcessSource();
  const identities = new ProcessIdentityStore('process:test', source);
  const adapter = new HostProcessAdapter(identities);
  const first = await identities.inspect(10);
  assert.ok(first);
  source.records.set(10, { pid: 10, startTicks: 999, name: 'replacement', state: 'running' });
  const observation = await adapter.observe({ adapterId: 'process:test', channel: 'process', target: first.ref });
  const data = observation.data as { identity: string; processes: unknown[] };
  assert.equal(data.identity, 'replaced');
  assert.deepEqual(data.processes, []);
});

test('argv execution preserves arguments and cwd without shell interpolation', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const identities = new ProcessIdentityStore('process:test');
    const adapter = new HostTerminalAdapter('terminal:test', identities);
    const request = argvRequest(cwd, {
      argv: ['-e', 'process.stdout.write(JSON.stringify(process.argv.slice(1)))', 'a b', '$(not-a-command)', 'semi;colon'],
    });
    const result = await adapter.act(request);
    assert.equal(result.status, 'completed');
    assert.equal(result.dispatch, 'dispatched-once');
    const details = result.details as TerminalExecutionDetails;
    assert.deepEqual(JSON.parse(details.stdout), ['a b', '$(not-a-command)', 'semi;colon']);

    const cwdResult = await adapter.act(argvRequest(cwd, { argv: ['-e', 'process.stdout.write(process.cwd())'] }));
    assert.equal((cwdResult.details as TerminalExecutionDetails).stdout, cwd);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('stdout and stderr capture are independently bounded', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'));
    const result = await adapter.act(argvRequest(cwd, {
      argv: ['-e', 'process.stdout.write("o".repeat(200));process.stderr.write("e".repeat(200))'],
      maxOutputBytes: 32,
    }));
    const details = result.details as TerminalExecutionDetails;
    assert.equal(Buffer.byteLength(details.stdout), 32);
    assert.equal(Buffer.byteLength(details.stderr), 32);
    assert.equal(details.stdoutTruncated, true);
    assert.equal(details.stderrTruncated, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('timeout is dispatched once and verified as timed out', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'));
    const result = await adapter.act(argvRequest(cwd, {
      argv: ['-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 50,
    }));
    assert.equal(result.status, 'failed');
    assert.equal(result.dispatch, 'dispatched-once');
    assert.equal(result.verification, 'verified');
    assert.equal((result.details as TerminalExecutionDetails).timedOut, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('timeout kill=false is bounded cleanup ambiguity', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const spawner: ProcessSpawner = { spawn() { return new FakeChild(false); } };
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner);
    const started = Date.now();
    const result = await adapter.act(argvRequest(cwd, { timeoutMs: 20 }));
    assert.ok(Date.now() - started < 500);
    assert.equal(result.status, 'unknown');
    assert.equal(result.dispatch, 'dispatched-once');
    assert.deepEqual(result.evidence, ['terminal.timeout.cleanup-ambiguous']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('timeout missing close is bounded by cleanup deadline', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const spawner: ProcessSpawner = { spawn() { return new FakeChild(true); } };
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner);
    const started = Date.now();
    const result = await adapter.act(argvRequest(cwd, { timeoutMs: 20 }));
    const elapsed = Date.now() - started;
    assert.ok(elapsed >= 20 && elapsed < 600);
    assert.equal(result.status, 'unknown');
    assert.deepEqual(result.evidence, ['terminal.timeout.cleanup-ambiguous']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('definite validation failure before spawn is not dispatched', async () => {
  let calls = 0;
  const spawner: ProcessSpawner = { spawn() { calls += 1; throw new Error('must not run'); } };
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner);
  const request = argvRequest(join(tmpdir(), 'missing-terminal-adapter-dir'));
  const result = await adapter.act(request);
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(calls, 0);
});

test('executable identity replacement before invocation fails closed', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    let fileBind = 0;
    const identity = (kind: 'file' | 'directory', ino: number, path: string): ExecutionPathIdentity => ({
      realPath: path, kind, dev: 1, ino, mode: kind === 'file' ? 0o100755 : 0o40755,
      birthtimeMs: 1, ...(kind === 'file' ? { size: 10, mtimeMs: 1 } : {}),
    });
    const binder: ExecutionPathBinder = {
      async bind(path, kind) {
        if (kind === 'file') return identity(kind, ++fileBind, path);
        return identity(kind, 99, path);
      },
    };
    let calls = 0;
    const spawner: ProcessSpawner = { spawn() { calls += 1; return new FakeChild(); } };
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner, binder);
    const result = await adapter.act(argvRequest(cwd));
    assert.equal(result.dispatch, 'not-dispatched');
    assert.deepEqual(result.evidence, ['terminal.executable.replaced']);
    assert.equal(calls, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('cwd identity replacement before invocation fails closed', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    let directoryBind = 0;
    const identity = (kind: 'file' | 'directory', ino: number, path: string): ExecutionPathIdentity => ({
      realPath: path, kind, dev: 1, ino, mode: kind === 'file' ? 0o100755 : 0o40755,
      birthtimeMs: 1, ...(kind === 'file' ? { size: 10, mtimeMs: 1 } : {}),
    });
    const binder: ExecutionPathBinder = {
      async bind(path, kind) {
        if (kind === 'directory') return identity(kind, ++directoryBind, path);
        return identity(kind, 77, path);
      },
    };
    let calls = 0;
    const spawner: ProcessSpawner = { spawn() { calls += 1; return new FakeChild(); } };
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner, binder);
    const result = await adapter.act(argvRequest(cwd));
    assert.equal(result.dispatch, 'not-dispatched');
    assert.deepEqual(result.evidence, ['terminal.cwd.replaced']);
    assert.equal(calls, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('throw after invocation is dispatch unknown and not auto-retry eligible', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    let calls = 0;
    const spawner: ProcessSpawner = { spawn() { calls += 1; throw new Error('ambiguous launch'); } };
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner);
    const request = argvRequest(cwd);
    const result = await adapter.act(request);
    assert.equal(calls, 1);
    assert.equal(result.dispatch, 'unknown');
    assert.equal(result.status, 'unknown');
    assert.equal(computerActionMayAutoRetry(request, result), false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('caller payload cannot self-authorize stronger effects', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    let calls = 0;
    const spawner: ProcessSpawner = { spawn() { calls += 1; return new FakeChild(); } };
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner);
    const request = argvRequest(cwd, { classification: 'package-installation' as const });
    const result = await adapter.act({ ...request, effect: 'system-configuration' });
    assert.equal(result.dispatch, 'not-dispatched');
    assert.deepEqual(result.evidence, ['terminal.effect.mismatch']);
    assert.equal(calls, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('argv and shell are separate capabilities and shell stays explicit', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const calls: Array<{ executable: string; argv: readonly string[]; shell: unknown }> = [];
    const spawner: ProcessSpawner = {
      spawn(executable, argv, options) {
        calls.push({ executable, argv: [...argv], shell: options.shell });
        const child = new FakeChild();
        queueMicrotask(() => child.emit('close', 0, null));
        return child;
      },
    };
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test', new FakeProcessSource()), spawner);
    const argvResult = await adapter.act(argvRequest(cwd, { argv: ['literal;argument'] }));
    assert.equal(argvResult.status, 'completed');
    assert.deepEqual(calls[0]?.argv, ['literal;argument']);
    assert.equal(calls[0]?.shell, false);

    const shellResult = await adapter.act({
      adapterId: 'terminal:test',
      actionId: 'shell-1',
      capability: 'terminal.execute.shell',
      effect: 'security-sensitive',
      idempotency: 'non-idempotent',
      payload: {
        mode: 'shell',
        shellExecutable: process.execPath,
        shellArgs: ['-e'],
        command: 'process.stdout.write("shell")',
        cwd,
        classification: 'local-compute',
      },
    });
    assert.equal(shellResult.status, 'completed');
    assert.deepEqual(calls[1]?.argv, ['-e', 'process.stdout.write("shell")']);
    assert.equal(calls[1]?.shell, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('shell argv plus command aggregate bytes are bounded', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    let calls = 0;
    const spawner: ProcessSpawner = { spawn() { calls += 1; return new FakeChild(); } };
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner);
    const result = await adapter.act({
      adapterId: 'terminal:test', actionId: 'shell-large', capability: 'terminal.execute.shell',
      effect: 'security-sensitive', idempotency: 'non-idempotent',
      payload: {
        mode: 'shell', shellExecutable: process.execPath, shellArgs: Array(9).fill('x'.repeat(4000)),
        command: 'echo', cwd, classification: 'local-compute',
      },
    });
    assert.equal(result.dispatch, 'not-dispatched');
    assert.deepEqual(result.evidence, ['terminal.shell.invalid']);
    assert.equal(calls, 0);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('non-zero exit is a verified command failure', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'));
    const result = await adapter.act(argvRequest(cwd, { argv: ['-e', 'process.exit(7)'] }));
    assert.equal(result.status, 'failed');
    assert.equal(result.verification, 'verified');
    assert.deepEqual(result.evidence, ['terminal.execution.nonzero-exit']);
    assert.equal((result.details as TerminalExecutionDetails).exitCode, 7);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('generic evidence never contains command output or secrets', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const secret = 'token-super-secret-value';
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'));
    const result = await adapter.act(argvRequest(cwd, {
      argv: ['-e', `process.stdout.write(${JSON.stringify(secret)});process.stderr.write(${JSON.stringify(secret)})`],
    }));
    const evidence = JSON.stringify(result.evidence ?? []);
    assert.equal(evidence.includes(secret), false);
    const details = result.details as TerminalExecutionDetails;
    assert.equal(details.stdout, secret);
    assert.equal(details.stderr, secret);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('unacknowledged returned child stays dispatch unknown', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const spawner: ProcessSpawner = {
      spawn() {
        const child = new FakeChild();
        child.pid = undefined;
        return child;
      },
    };
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner);
    const result = await adapter.act(argvRequest(cwd));
    assert.equal(result.dispatch, 'unknown');
    assert.equal(result.status, 'unknown');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('terminal observation exposes and validates generation-aware session identity', async () => {
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'));
  const observation = await adapter.observe({ adapterId: 'terminal:test', channel: 'terminal' });
  const data = observation.data as { session: { adapterId: string; environment: 'terminal'; kind: 'terminal-session'; entityId: string; generation?: number } };
  assert.equal(data.session.kind, 'terminal-session');
  assert.equal(data.session.generation, 0);

  const current = await adapter.observe({ adapterId: 'terminal:test', channel: 'terminal', target: data.session });
  assert.equal(current.complete, true);
  const stale = await adapter.observe({
    adapterId: 'terminal:test', channel: 'terminal', target: { ...data.session, generation: 1 },
  });
  assert.equal(stale.complete, false);
  assert.deepEqual(stale.data, { code: 'terminal.session.stale' });
});
