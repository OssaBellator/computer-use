import test from 'node:test';
import assert from 'node:assert/strict';
import { HostProcessAdapter, ProcessIdentityStore, type ProcessSnapshotSource } from '../src/computer/processAdapter.js';

const mismatchedSource: ProcessSnapshotSource = {
  async listPids() { return { pids: [100], truncated: false }; },
  async inspect() { return { pid: 200, startTicks: 77, name: 'wrong-process', state: 'running' }; },
};

test('targeted process observation rejects a mismatched source record identity', async () => {
  const identities = new ProcessIdentityStore('process:test', mismatchedSource);
  const adapter = new HostProcessAdapter(identities);
  const target = identities.ref(100, 77);
  const observation = await adapter.observe({ adapterId: 'process:test', channel: 'process', target });
  const data = observation.data as { processes: Array<{ pid: number }>; identity: string };
  assert.equal(data.identity, 'exited');
  assert.deepEqual(data.processes, []);
});

test('spawn acknowledgement never returns a mismatched source PID', async () => {
  const identities = new ProcessIdentityStore('process:test', mismatchedSource);
  const ref = await identities.acknowledgeSpawn(100);
  assert.equal(ref.entityId, 'pid:100');
  assert.equal(typeof ref.generation, 'number');
  assert.notEqual(ref.entityId, 'pid:200');
});

test('list observation omits records whose source PID differs from the candidate PID', async () => {
  const identities = new ProcessIdentityStore('process:test', mismatchedSource);
  const adapter = new HostProcessAdapter(identities);
  const observation = await adapter.observe({ adapterId: 'process:test', channel: 'process', limits: { maxItems: 1 } });
  const data = observation.data as { processes: Array<{ pid: number }> };
  assert.deepEqual(data.processes, []);
});
