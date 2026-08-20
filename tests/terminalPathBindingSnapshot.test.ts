import test from 'node:test';
import assert from 'node:assert/strict';
import { ProcessIdentityStore } from '../src/computer/processAdapter.js';
import { HostTerminalAdapter, type ExecutionPathBinder, type ProcessSpawner } from '../src/computer/terminalAdapter.js';

test('accessor-backed path identity is rejected without getter execution or spawn', async () => {
  let getters = 0;
  let spawns = 0;
  const identity: Record<string, unknown> = {
    kind: 'file', dev: '1', ino: '2', mode: '3', size: '4', mtimeNs: '5', birthtimeNs: '6', ctimeNs: '7',
  };
  Object.defineProperty(identity, 'realPath', {
    enumerable: true,
    get() { getters += 1; return getters === 1 ? '/evil' : '/safe'; },
  });
  const binder: ExecutionPathBinder = {
    async bind(_path, kind) {
      if (kind === 'file') return identity as any;
      return { realPath: '/fixture', kind: 'directory', dev: '1', ino: '20', mode: '16877', birthtimeNs: '1', ctimeNs: '2' };
    },
  };
  const spawner: ProcessSpawner = { spawn() { spawns += 1; throw new Error('must not spawn'); } };
  const adapter = new HostTerminalAdapter('terminal:test', new ProcessIdentityStore('process:test'), spawner, binder);
  const result = await adapter.act({
    adapterId: 'terminal:test', actionId: 'path-accessor', capability: 'terminal.execute.argv',
    effect: 'security-sensitive', idempotency: 'non-idempotent',
    payload: { mode: 'argv', executable: '/fixture/tool', argv: [], cwd: '/fixture', classification: 'local-compute' },
  });
  assert.equal(result.dispatch, 'not-dispatched');
  assert.deepEqual(result.evidence, ['terminal.executable.unavailable']);
  assert.equal(getters, 0);
  assert.equal(spawns, 0);
});
