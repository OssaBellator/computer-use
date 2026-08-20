import test from 'node:test';
import assert from 'node:assert/strict';
import { HostProcessAdapter, ProcessIdentityStore, type ProcessSnapshotSource } from '../src/computer/processAdapter.js';

test('process maxItems bounds backend PID acquisition and candidate inspection', async () => {
  let requestedCandidates = 0;
  let materializedCandidates = 0;
  let inspected = 0;
  const hugeSource: ProcessSnapshotSource = {
    async listPids(maxCandidates) {
      requestedCandidates = maxCandidates;
      const pids = Array.from({ length: maxCandidates }, (_, index) => index + 1);
      materializedCandidates = pids.length;
      return { pids, truncated: true };
    },
    async inspect(pid) {
      inspected += 1;
      return { pid, startTicks: pid, name: `p${pid}`, state: 'running' };
    },
  };

  const adapter = new HostProcessAdapter(new ProcessIdentityStore('process:test', hugeSource));
  const observation = await adapter.observe({ adapterId: 'process:test', channel: 'process', limits: { maxItems: 1 } });
  const data = observation.data as { processes: Array<{ pid: number }> };

  assert.equal(data.processes.length, 1);
  assert.equal(observation.truncated, true);
  assert.ok(requestedCandidates <= 4, `maxItems=1 requested too many candidates: ${requestedCandidates}`);
  assert.equal(materializedCandidates, requestedCandidates);
  assert.equal(inspected, 1);
});
