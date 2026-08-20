import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import { ProcessIdentityStore, type ProcessSnapshotSource } from '../src/computer/processAdapter.js';
import {
  HostTerminalAdapter,
  type ExecutionPathBinder,
  type ProcessSpawner,
  type SpawnedProcessLike,
} from '../src/computer/terminalAdapter.js';

class RegistryChild extends EventEmitter implements SpawnedProcessLike {
  pid = 51515;
  stdout = new PassThrough();
  stderr = new PassThrough();

  constructor(
    private readonly closeCode: number | null,
    private readonly closeSignal: NodeJS.Signals | null,
    private readonly closeOnSpawn: boolean,
  ) {
    super();
    if (closeOnSpawn) queueMicrotask(() => this.emit('close', closeCode, closeSignal));
  }

  kill(): boolean {
    queueMicrotask(() => this.emit('close', null, 'SIGKILL'));
    return true;
  }
}

const source: ProcessSnapshotSource = {
  async listPids() { return [51515]; },
  async inspect(pid) {
    return pid === 51515
      ? { pid, startTicks: 515, name: 'registry-fixture', state: 'running' }
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

function request(actionId: string, timeoutMs?: number) {
  return {
    adapterId: 'terminal:registry',
    actionId,
    capability: 'terminal.execute.argv',
    effect: 'security-sensitive' as const,
    idempotency: 'non-idempotent' as const,
    payload: {
      mode: 'argv' as const,
      executable: '/fixture/bin',
      argv: ['--harmless-fixture'],
      cwd: '/fixture',
      classification: 'local-compute' as const,
      ...(timeoutMs === undefined ? {} : { timeoutMs }),
    },
  };
}

function registryWith(spawner: ProcessSpawner): ComputerEnvironmentRegistry {
  const registry = new ComputerEnvironmentRegistry();
  registry.register(new HostTerminalAdapter(
    'terminal:registry',
    new ProcessIdentityStore('process:registry', source),
    spawner,
    binder,
  ));
  return registry;
}

test('registry preserves stronger-effect zero-exit dispatch without domain verification', async () => {
  const registry = registryWith({
    spawn() { return new RegistryChild(0, null, true); },
  });
  const result = await registry.act(request('registry-zero'));
  assert.equal(result.status, 'completed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(result.verification, 'not-applicable');
  assert.deepEqual(result.evidence, ['terminal.execution.exited-zero-domain-unverified']);
});

test('registry preserves stronger-effect non-zero dispatch without domain verification', async () => {
  const registry = registryWith({
    spawn() { return new RegistryChild(7, null, true); },
  });
  const result = await registry.act(request('registry-nonzero'));
  assert.equal(result.status, 'failed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(result.verification, 'not-applicable');
  assert.deepEqual(result.evidence, ['terminal.execution.nonzero-exit-domain-unverified']);
});

test('registry preserves stronger-effect timeout dispatch without domain verification', async () => {
  const registry = registryWith({
    spawn() { return new RegistryChild(null, null, false); },
  });
  const result = await registry.act(request('registry-timeout', 20));
  assert.equal(result.status, 'failed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(result.verification, 'not-applicable');
  assert.deepEqual(result.evidence, ['terminal.execution.timeout-domain-unverified']);
});
