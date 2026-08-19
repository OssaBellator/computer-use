import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime, evaluateTaskPredicate, taskObservationFingerprint, type TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import type { BrowserDownloadSummary } from '../src/browser/downloadController.js';
import type { TaskProgram } from '../src/agent/taskProgram.js';

const summary = (completed: number): BrowserDownloadSummary => ({
  total: completed, inProgress: 0, completed, canceled: 0,
  ...(completed ? {
    latest: { guid: 'opaque', state: 'completed', receivedBytes: 5, sequence: 1 },
    latestCompleted: { guid: 'opaque', state: 'completed', receivedBytes: 5, sequence: 1 },
  } : {}),
});

test('download predicates and fingerprints use structural completion state only', () => {
  assert.equal(evaluateTaskPredicate(
    { kind: 'downloads', state: { completedCountAtLeast: 1 } },
    [], {}, undefined, undefined, undefined, summary(1),
  ), true);
  assert.notEqual(
    taskObservationFingerprint([], undefined, undefined, undefined, summary(0)),
    taskObservationFingerprint([], undefined, undefined, undefined, summary(1)),
  );
});

test('task runtime can require verified download completion after a declared side effect', async () => {
  let downloads = summary(0);
  const engine: TaskRuntimeEngine = {
    async refresh() { return []; },
    downloadState() { return downloads; },
    async activate() {
      downloads = summary(1);
      return { status: 'verified', target: null };
    },
    async typeInto() { throw new Error('not used'); },
  };
  const program: TaskProgram = {
    version: 1,
    entry: 'trigger',
    steps: [
      {
        id: 'trigger', kind: 'activate', target: 'download-link',
        risk: 'external-side-effect', next: 'verify', onFailure: 'failed',
      },
      {
        id: 'verify', kind: 'assert',
        condition: { kind: 'downloads', state: { completedCountAtLeast: 1 } },
        next: 'done', onFailure: 'failed',
      },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };
  const result = await new TaskRuntime(engine).run(program, {}, {
    approve: ({ stepId }) => stepId === 'trigger',
  });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['verified', 'asserted', 'completed']);
});
