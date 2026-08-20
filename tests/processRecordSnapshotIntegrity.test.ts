import test from 'node:test';
import assert from 'node:assert/strict';
import { HostProcessAdapter, ProcessIdentityStore, type ProcessRecord, type ProcessSnapshotSource } from '../src/computer/processAdapter.js';

function changingRecord(): { record: ProcessRecord; getterCalls: () => number } {
  let calls = 0;
  const record: Record<string, unknown> = {
    name: 'mutable-source',
    state: 'running',
  };
  Object.defineProperty(record, 'pid', {
    enumerable: true,
    get() {
      calls += 1;
      return calls === 1 ? 100 : 200;
    },
  });
  Object.defineProperty(record, 'startTicks', {
    enumerable: true,
    get() {
      calls += 1;
      return calls === 1 ? 77 : 88;
    },
  });
  return { record: record as unknown as ProcessRecord, getterCalls: () => calls };
}

function sourceFor(recordFactory: () => ProcessRecord): ProcessSnapshotSource {
  return {
    async listPids() { return { pids: [100], truncated: false }; },
    async inspect() { return recordFactory(); },
  };
}

test('accessor-backed process records are rejected without executing source getters', async () => {
  const changing = changingRecord();
  const source: ProcessSnapshotSource = {
    async listPids() { return { pids: [100], truncated: false }; },
    async inspect() { return changing.record; },
  };
  const identities = new ProcessIdentityStore('process:test', source);
  const adapter = new HostProcessAdapter(identities);
  const target = identities.ref(100, 77);
  const observation = await adapter.observe({ adapterId: 'process:test', channel: 'process', target });
  const data = observation.data as { processes: Array<{ pid: number }>; identity: string };
  assert.equal(data.identity, 'exited');
  assert.deepEqual(data.processes, []);
  assert.equal(changing.getterCalls(), 0);
});

test('spawn acknowledgement cannot turn a changing source record into a foreign ref or generation', async () => {
  const changing = changingRecord();
  const identities = new ProcessIdentityStore('process:test', sourceFor(() => changing.record));
  const ref = await identities.acknowledgeSpawn(100);
  assert.equal(ref.entityId, 'pid:100');
  assert.notEqual(ref.generation, 77);
  assert.notEqual(ref.generation, 88);
  assert.equal(changing.getterCalls(), 0);
});

test('process record snapshot uses only bounded schema descriptor reads', async () => {
  let extraGetterCalls = 0;
  const record: Record<string, unknown> = {
    pid: 100,
    startTicks: 77,
    name: 'bounded-source',
    state: 'running',
  };
  Object.defineProperty(record, 'irrelevant', {
    enumerable: true,
    get() {
      extraGetterCalls += 1;
      return 'ignored';
    },
  });
  const symbol = Symbol('irrelevant');
  Object.defineProperty(record, symbol, {
    enumerable: true,
    get() {
      extraGetterCalls += 1;
      return 'ignored';
    },
  });

  const originalDescriptors = Object.getOwnPropertyDescriptors;
  const originalSymbols = Object.getOwnPropertySymbols;
  Object.getOwnPropertyDescriptors = ((value: object) => {
    if (value === record) throw new Error('bulk descriptor enumeration forbidden');
    return originalDescriptors(value);
  }) as typeof Object.getOwnPropertyDescriptors;
  Object.getOwnPropertySymbols = ((value: object) => {
    if (value === record) throw new Error('bulk symbol enumeration forbidden');
    return originalSymbols(value);
  }) as typeof Object.getOwnPropertySymbols;
  try {
    const identities = new ProcessIdentityStore('process:test', sourceFor(() => record as unknown as ProcessRecord));
    const snapshot = await identities.inspect(100);
    assert.equal(snapshot?.pid, 100);
    assert.equal(snapshot?.ref.entityId, 'pid:100');
    assert.equal(snapshot?.ref.generation, 77);
    assert.equal(extraGetterCalls, 0);
  } finally {
    Object.getOwnPropertyDescriptors = originalDescriptors;
    Object.getOwnPropertySymbols = originalSymbols;
  }
});
