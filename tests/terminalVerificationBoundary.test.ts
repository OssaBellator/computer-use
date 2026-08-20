import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ProcessIdentityStore, type ProcessSnapshotSource } from '../src/computer/processAdapter.js';
import {
  HostTerminalAdapter,
  type ExecutionPathBinder,
  type ProcessSpawner,
  type SpawnedProcessLike,
  type TerminalExecutionEffectResolver,
} from '../src/computer/terminalAdapter.js';

class ClosingChild extends EventEmitter implements SpawnedProcessLike {
  pid = 43210;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): boolean { return true; }
}

const source: ProcessSnapshotSource = {
  async listPids() { return [43210]; },
  async inspect(pid) {
    return pid === 43210
      ? { pid, startTicks: 44, name: 'fixture', state: 'running' }
      : undefined;
  },
};

const binder: ExecutionPathBinder = {
  async bind(path, kind) {
    return {
      realPath: path,
      kind,
      dev: '1',
      ino: kind === 'file' ? '2' : '3',
      mode: kind === 'file' ? '33261' : '16877',
      birthtimeNs: '10',
      ctimeNs: '11',
      ...(kind === 'file' ? { size: '12', mtimeNs: '13' } : {}),
    };
  },
};

const spawner: ProcessSpawner = {
  spawn() {
    const child = new ClosingChild();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  },
};

const request = (effect: 'security-sensitive' | 'process-execution') => ({
  adapterId: 'terminal:test',
  actionId: 'verify-boundary',
  capability: 'terminal.execute.argv',
  effect,
  idempotency: 'non-idempotent' as const,
  payload: {
    mode: 'argv' as const,
    executable: '/fixture/bin',
    argv: ['--harmless-fixture'],
    cwd: '/fixture',
    classification: 'local-compute' as const,
  },
});

test('security-sensitive zero exit is dispatched but not domain-verified', async () => {
  const adapter = new HostTerminalAdapter(
    'terminal:test',
    new ProcessIdentityStore('process:test', source),
    spawner,
    binder,
  );
  const result = await adapter.act(request('security-sensitive'));
  assert.equal(result.status, 'completed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(result.verification, 'unverified');
  assert.deepEqual(result.evidence, ['terminal.execution.exited-zero-domain-unverified']);
});

test('trusted process-execution may use exit status as its domain verifier', async () => {
  const resolver: TerminalExecutionEffectResolver = {
    requiredEffect() { return 'process-execution'; },
  };
  const adapter = new HostTerminalAdapter(
    'terminal:test',
    new ProcessIdentityStore('process:test', source),
    spawner,
    binder,
    resolver,
  );
  const result = await adapter.act(request('process-execution'));
  assert.equal(result.status, 'completed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(result.verification, 'verified');
  assert.deepEqual(result.evidence, ['terminal.execution.exited-zero']);
});
