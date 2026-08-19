import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime, evaluateTaskPredicate, taskObservationFingerprint, type TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import type { TaskProgram } from '../src/agent/taskProgram.js';
import type { BrowserTargetSummary } from '../src/browser/targetController.js';

function summary(unattachedPages: number): BrowserTargetSummary {
  return {
    total: 1 + unattachedPages,
    pages: 1 + unattachedPages,
    unattachedPages,
    latestPage: unattachedPages
      ? { targetId: 'secondary', type: 'page', attached: false, sequence: 2 }
      : { targetId: 'main', type: 'page', attached: true, sequence: 1 },
    ...(unattachedPages ? {
      latestUnattachedPage: { targetId: 'secondary', type: 'page', attached: false, sequence: 2 },
    } : {}),
  };
}

test('target predicates and fingerprints use structural lifecycle state only', () => {
  const state = summary(1);
  assert.equal(evaluateTaskPredicate({ kind: 'targets', state: { pageCountAtLeast: 2, unattachedPageCountAtLeast: 1 } }, [], {}, undefined, undefined, state), true);
  assert.notEqual(taskObservationFingerprint([], undefined, undefined, summary(0)), taskObservationFingerprint([], undefined, undefined, state));
  assert.equal(JSON.stringify(state).includes('http'), false);
});

test('task runtime opens and closes a secondary tab through predeclared topology actions', async () => {
  let targets = summary(0);
  let openedUrl: string | undefined;
  const engine: TaskRuntimeEngine = {
    async refresh() { return []; },
    targetState() { return targets; },
    async createPageTarget(url) {
      openedUrl = url;
      targets = summary(1);
      return { status: 'created', requestedUrl: url, targetId: 'secondary' };
    },
    async closeLatestUnattachedPage() {
      if (!targets.latestUnattachedPage) return undefined;
      targets = summary(0);
      return { status: 'closed', targetId: 'secondary' };
    },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const program: TaskProgram = {
    version: 1,
    entry: 'open',
    inputs: ['destination'],
    steps: [
      { id: 'open', kind: 'open-tab', url: { input: 'destination' }, next: 'verify-open', onFailure: 'failed' },
      { id: 'verify-open', kind: 'assert', condition: { kind: 'targets', state: { unattachedPageCountAtLeast: 1 } }, next: 'close' },
      { id: 'close', kind: 'close-latest-tab', next: 'verify-closed', onFailure: 'failed' },
      { id: 'verify-closed', kind: 'assert', condition: { kind: 'not', predicate: { kind: 'targets', state: { unattachedPageCountAtLeast: 1 } } }, next: 'done' },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };
  const destination = 'https://example.test/private-destination';
  const result = await new TaskRuntime(engine).run(program, { destination });
  assert.equal(result.status, 'completed');
  assert.equal(openedUrl, destination);
  assert.deepEqual(result.trace.map((entry) => entry.outcome), [
    'target-created', 'asserted', 'target-closed', 'asserted', 'completed',
  ]);
  assert.equal(JSON.stringify(result.trace).includes(destination), false);
});
