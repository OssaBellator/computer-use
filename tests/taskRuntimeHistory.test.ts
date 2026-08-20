import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime, type TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import type { TaskProgram } from '../src/agent/taskProgram.js';
import type { BrowserHistoryAction, BrowserHistoryOptions } from '../src/browser/historyController.js';
import type { BrowserStateSnapshot } from '../src/browser/browserState.js';

function browser(url: string, timeOrigin: number): BrowserStateSnapshot {
  return {
    url,
    origin: 'null',
    title: '',
    readyState: 'complete',
    historyLength: 2,
    timeOrigin,
  };
}

test('task runtime executes only the predeclared browser-history action and redacts history state', async () => {
  let current = browser('about:blank#two', 10);
  const calls: Array<[BrowserHistoryAction, BrowserHistoryOptions | undefined]> = [];
  const engine: TaskRuntimeEngine = {
    async refresh() { return []; },
    async browserState() { return current; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
    async history(action, options) {
      calls.push([action, options]);
      if (action === 'back') current = browser('about:blank#one', 10);
      if (action === 'reload') current = browser(current.url, current.timeOrigin + 1);
      return { status: 'navigated', action, before: undefined, after: current, polls: 1 };
    },
  };

  const program: TaskProgram = {
    version: 1,
    entry: 'back',
    steps: [
      {
        id: 'back',
        kind: 'history',
        action: 'back',
        waitUntil: 'commit',
        next: 'assert-back',
        onFailure: 'failed',
      },
      {
        id: 'assert-back',
        kind: 'assert',
        condition: { kind: 'browser', state: { url: 'about:blank#one' } },
        next: 'reload',
        onFailure: 'failed',
      },
      {
        id: 'reload',
        kind: 'history',
        action: 'reload',
        ignoreCache: true,
        next: 'done',
        onFailure: 'failed',
      },
      {
        id: 'done',
        kind: 'complete',
        condition: { kind: 'browser', state: { url: 'about:blank#one' } },
      },
      { id: 'failed', kind: 'fail' },
    ],
  };

  const result = await new TaskRuntime(engine).run(program);
  assert.equal(result.status, 'completed');
  assert.deepEqual(calls, [
    ['back', { waitUntil: 'commit', timeoutMs: undefined, maxPolls: undefined, pollIntervalMs: undefined, ignoreCache: undefined }],
    ['reload', { waitUntil: undefined, timeoutMs: undefined, maxPolls: undefined, pollIntervalMs: undefined, ignoreCache: true }],
  ]);
  assert.deepEqual(
    result.trace.map((entry) => entry.outcome),
    ['history-navigated', 'asserted', 'history-navigated', 'completed'],
  );
  assert.equal(JSON.stringify(result.trace).includes('about:blank#one'), false);
});

test('history step fails closed when the engine does not expose history control', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return []; },
    async browserState() { return browser('about:blank', 1); },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const program: TaskProgram = {
    version: 1,
    entry: 'back',
    steps: [
      { id: 'back', kind: 'history', action: 'back', next: 'done', onFailure: 'failed' },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };

  const result = await new TaskRuntime(engine).run(program, {}, { maxConsecutiveNoProgress: 10 });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['failed', 'failed']);
});
