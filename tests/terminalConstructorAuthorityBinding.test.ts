import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { HostTerminalAdapter, type ExecutionPathBinder, type ProcessSpawner, type SpawnedProcessLike } from '../src/computer/terminalAdapter.js';
import { ProcessIdentityStore, type ProcessSnapshotSource } from '../src/computer/processAdapter.js';

const source: ProcessSnapshotSource = {
  async listPids() { return { pids: [], truncated: false }; },
  async inspect() { return undefined; },
};

function request() {
  return {
    adapterId: 'terminal:test', actionId: 'a', capability: 'terminal.execute.argv', effect: 'security-sensitive', idempotency: 'non-idempotent',
    payload: { mode: 'argv', executable: '/bin/echo', argv: ['ok'], cwd: '/tmp', env: {}, classification: 'local-compute' },
  } as const;
}

test('binder and spawner method replacement after construction cannot change authority', async () => {
  let originalBindCalls = 0;
  let replacementBindCalls = 0;
  let originalSpawnCalls = 0;
  let replacementSpawnCalls = 0;

  const binder: ExecutionPathBinder = {
    async bind(path, kind) {
      originalBindCalls += 1;
      return kind === 'file'
        ? { realPath: path, kind, dev: '1', ino: '2', mode: '3', size: '4', mtimeNs: '5', birthtimeNs: '6', ctimeNs: '7' }
        : { realPath: path, kind, dev: '1', ino: '8', mode: '9', birthtimeNs: '10', ctimeNs: '11' };
    },
  };

  const spawner: ProcessSpawner = {
    spawn() {
      originalSpawnCalls += 1;
      const child: SpawnedProcessLike = {
        pid: 123,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        once(event, listener) {
          if (event === 'close') queueMicrotask(() => listener(0, null));
          return this;
        },
        kill() { return true; },
      };
      return child;
    },
  };

  const adapter = new HostTerminalAdapter(
    'terminal:test',
    new ProcessIdentityStore('process:test', source),
    spawner,
    binder,
  );

  binder.bind = async () => {
    replacementBindCalls += 1;
    throw new Error('replacement binder must not run');
  };
  spawner.spawn = () => {
    replacementSpawnCalls += 1;
    throw new Error('replacement spawner must not run');
  };

  const result = await adapter.act(request());
  assert.equal(result.status, 'completed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(originalBindCalls, 4);
  assert.equal(replacementBindCalls, 0);
  assert.equal(originalSpawnCalls, 1);
  assert.equal(replacementSpawnCalls, 0);
});
