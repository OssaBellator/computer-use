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
  type TerminalExecutionDetails,
} from '../src/computer/terminalAdapter.js';

class ClosingChild extends EventEmitter implements SpawnedProcessLike {
  pid = 55555;
  stdout = new PassThrough();
  stderr = new PassThrough();
  kill(): boolean { return true; }
}

const hangingSource: ProcessSnapshotSource = {
  async listPids() { return { pids: [], truncated: false }; },
  async inspect() { return await new Promise<never>(() => {}); },
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

test('hanging post-spawn identity lookup cannot delay known terminal outcome', async () => {
  const adapter = new HostTerminalAdapter(
    'terminal:test',
    new ProcessIdentityStore('process:test', hangingSource),
    spawner,
    binder,
  );
  const started = Date.now();
  const result = await adapter.act({
    adapterId: 'terminal:test',
    actionId: 'bounded-ack',
    capability: 'terminal.execute.argv',
    effect: 'security-sensitive',
    idempotency: 'non-idempotent',
    payload: {
      mode: 'argv',
      executable: '/fixture/bin',
      argv: ['--fixture'],
      cwd: '/fixture',
      classification: 'local-compute',
      timeoutMs: 1000,
    },
  });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 250, `post-spawn acknowledgement exceeded bound: ${elapsed}ms`);
  assert.equal(result.status, 'completed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(result.verification, 'not-applicable');
  const details = result.details as TerminalExecutionDetails;
  assert.equal(details.process?.entityId, 'pid:55555');
  assert.equal(typeof details.process?.generation, 'number');
});
