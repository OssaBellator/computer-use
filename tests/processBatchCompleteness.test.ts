import test from 'node:test';
import assert from 'node:assert/strict';
import { HostProcessAdapter, ProcessIdentityStore, type ProcessSnapshotSource } from '../src/computer/processAdapter.js';

test('disappearing bounded candidate batch remains explicitly truncated', async () => {
  let requested = 0;
  let inspected = 0;
  const source: ProcessSnapshotSource = {
    async listPids(maxCandidates) {
      requested = maxCandidates;
      return {
        pids: Array.from({ length: maxCandidates }, (_, index) => index + 1),
        truncated: true,
      };
    },
    async inspect() {
      inspected += 1;
      return undefined;
    },
  };
  const adapter = new HostProcessAdapter(new ProcessIdentityStore('process:test', source));
  const observation = await adapter.observe({
    adapterId: 'process:test',
    channel: 'process',
    limits: { maxItems: 1 },
  });
  assert.equal(requested, 4);
  assert.equal(inspected, 4);
  assert.equal(observation.truncated, true);
  assert.equal(observation.complete, false);
  assert.deepEqual((observation.data as { processes: unknown[] }).processes, []);
});

test('over-limit source batch is capped and treated as truncated', async () => {
  let inspected = 0;
  const source: ProcessSnapshotSource = {
    async listPids(maxCandidates) {
      return {
        pids: Array.from({ length: maxCandidates + 100 }, (_, index) => index + 1),
        truncated: false,
      };
    },
    async inspect(pid) {
      inspected += 1;
      return { pid, startTicks: pid, name: `p${pid}`, state: 'running' };
    },
  };
  const adapter = new HostProcessAdapter(new ProcessIdentityStore('process:test', source));
  const observation = await adapter.observe({ adapterId: 'process:test', channel: 'process', limits: { maxItems: 1 } });
  assert.equal(inspected, 1);
  assert.equal(observation.truncated, true);
  assert.equal(observation.complete, false);
});
