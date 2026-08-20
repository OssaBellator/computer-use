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
  type ProcessSpawner,
  type SpawnedProcessLike,
  type TerminalExecutionDetails,
} from '../src/computer/terminalAdapter.js';

class FakeProcessSource implements ProcessSnapshotSource {
  pids = [10, 11, 12];
  records = new Map<number, ProcessRecord>([
    [10, { pid: 10, startTicks: 100, name: 'a'.repeat(300), state: 'running', rssBytes: 10 }],
    [11, { pid: 11, startTicks: 110, name: 'beta', state: 'sleeping', rssBytes: 20 }],
    [12, { pid: 12, startTicks: 120, name: 'gamma', state: 'waiting', rssBytes: 30 }],
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
      approvedEffects: ['process-execution' as const],
      ...overrides,
    },
  };
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

test('definite validation failure before spawn is not dispatched', async () => {
  let calls = 0;
  const spawner: ProcessSpawner = { spawn() { calls += 1; throw new Error('must not run'); } };
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner);
  const request = argvRequest(join(tmpdir(), 'missing-terminal-adapter-dir'));
  const result = await adapter.act(request);
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(calls, 0);
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

class FakeChild extends EventEmitter implements SpawnedProcessLike {
  pid = 424242;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): boolean { return true; }
}

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
        approvedEffects: ['process-execution', 'security-sensitive'],
      },
    });
    assert.equal(shellResult.status, 'completed');
    assert.deepEqual(calls[1]?.argv, ['-e', 'process.stdout.write("shell")']);
    assert.equal(calls[1]?.shell, false);
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

test('unacknowledged spawn failure stays unknown without an unhandled child error', async () => {
  const cwd = await mkdtemp(join(tmpdir(), 'terminal-adapter-'));
  try {
    const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'));
    const result = await adapter.act(argvRequest(cwd, { executable: join(cwd, 'definitely-missing-executable') }));
    assert.equal(result.dispatch, 'unknown');
    assert.equal(result.status, 'unknown');
  } finally {
    await new Promise((resolve) => setImmediate(resolve));
    await rm(cwd, { recursive: true, force: true });
  }
});

test('terminal observation exposes a generation-aware session entity', async () => {
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'));
  const observation = await adapter.observe({ adapterId: 'terminal:test', channel: 'terminal' });
  const data = observation.data as { session: { kind: string; generation?: number } };
  assert.equal(data.session.kind, 'terminal-session');
  assert.equal(data.session.generation, 0);
});
