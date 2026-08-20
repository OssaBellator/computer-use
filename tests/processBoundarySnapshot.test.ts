import test from 'node:test';
import assert from 'node:assert/strict';
import { HostProcessAdapter, ProcessIdentityStore, type ProcessSnapshotSource } from '../src/computer/processAdapter.js';

test('PID batch envelope accessors are rejected without getter execution', async () => {
  let getters = 0;
  const batch: Record<string, unknown> = {};
  Object.defineProperty(batch, 'pids', { enumerable: true, get() { getters += 1; return [100]; } });
  Object.defineProperty(batch, 'truncated', { enumerable: true, get() { getters += 1; return false; } });
  const source: ProcessSnapshotSource = {
    async listPids() { return batch as any; },
    async inspect() { throw new Error('must not inspect'); },
  };
  const result = await new ProcessIdentityStore('process:test', source).list(1);
  assert.deepEqual(result.items, []);
  assert.equal(result.truncated, true);
  assert.equal(getters, 0);
});

test('PID batch uses descriptor snapshot rather than proxy get and rejects sparse arrays', async () => {
  let gets = 0;
  const proxiedPids = new Proxy([100], {
    get(target, key, receiver) { gets += 1; return Reflect.get(target, key, receiver); },
  });
  const goodSource: ProcessSnapshotSource = {
    async listPids() { return { pids: proxiedPids as any, truncated: false }; },
    async inspect(pid) { return { pid, startTicks: 7, name: 'p', state: 'running' }; },
  };
  const good = await new ProcessIdentityStore('process:test', goodSource).list(1);
  assert.equal(good.items[0]?.pid, 100);
  assert.equal(gets, 0);

  const sparse = new Array<number>(2); sparse[0] = 100;
  const sparseSource: ProcessSnapshotSource = {
    async listPids() { return { pids: sparse, truncated: false }; },
    async inspect() { throw new Error('must not inspect sparse batch'); },
  };
  const rejected = await new ProcessIdentityStore('process:test', sparseSource).list(1);
  assert.deepEqual(rejected.items, []);
  assert.equal(rejected.truncated, true);
});

test('targeted observation stays bound to request target, generation, and limits captured before await', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const enteredGate = new Promise<void>((resolve) => { entered = resolve; });
  const source: ProcessSnapshotSource = {
    async listPids() { return { pids: [100], truncated: false }; },
    async inspect(pid) {
      assert.equal(pid, 100);
      entered();
      await gate;
      return { pid: 100, startTicks: 77, name: 'abcdef', state: 'running' };
    },
  };
  const identities = new ProcessIdentityStore('process:test', source);
  const adapter = new HostProcessAdapter(identities);
  const target: any = identities.ref(100, 77);
  const limits: any = { maxTextBytes: 1 };
  const request: any = { adapterId: 'process:test', channel: 'process', target, limits };
  const pending = adapter.observe(request);
  await enteredGate;
  target.entityId = 'pid:200';
  target.generation = 88;
  limits.maxTextBytes = 100;
  release();
  const observation = await pending;
  assert.equal(observation.target?.entityId, 'pid:100');
  assert.equal(observation.target?.generation, 77);
  const data = observation.data as { identity: string; processes: Array<{ pid: number; name: string }> };
  assert.equal(data.identity, 'current');
  assert.equal(data.processes[0]?.pid, 100);
  assert.equal(data.processes[0]?.name, 'a');
  assert.equal(observation.truncated, true);
});
