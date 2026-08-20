import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TaskRuntime,
  evaluateTaskPredicate,
  taskObservationFingerprint,
  type TaskRuntimeEngine,
} from '../src/agent/taskRuntime.js';
import type { TaskProgram } from '../src/agent/taskProgram.js';
import type { BrowserStateSnapshot } from '../src/browser/browserState.js';

function browser(url: string, title = ''): BrowserStateSnapshot {
  return {
    url,
    origin: url.startsWith('about:') ? 'null' : new URL(url).origin,
    title,
    readyState: 'complete',
    historyLength: 2,
    timeOrigin: url.includes('start') ? 1000 : 2000,
  };
}

test('browser predicates can gate predeclared branches without exposing page state in traces', () => {
  const state = browser('https://example.test/account', 'Account');
  assert.equal(evaluateTaskPredicate({
    kind: 'browser',
    state: { urlIncludes: '/account', title: 'Account', readyState: 'complete' },
  }, [], {}, state), true);
  assert.equal(evaluateTaskPredicate({
    kind: 'browser',
    state: { url: 'https://elsewhere.test/' },
  }, [], {}, state), false);
});

test('browser state participates in progress fingerprints even when semantic nodes do not change', () => {
  assert.notEqual(
    taskObservationFingerprint([], browser('https://example.test/a')),
    taskObservationFingerprint([], browser('https://example.test/b')),
  );
});

test('navigate steps use trusted inputs, verify browser state, and redact URLs from traces', async () => {
  let state = browser('about:blank#start');
  const engine: TaskRuntimeEngine = {
    async refresh() { return []; },
    async browserState() { return state; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
    async navigate(url) {
      state = browser(url, 'Destination');
      return {
        status: 'navigated',
        requestedUrl: url,
        before: browser('about:blank#start'),
        after: state,
        polls: 1,
      };
    },
  };
  const program: TaskProgram = {
    version: 1,
    entry: 'go',
    inputs: ['destination'],
    steps: [
      { id: 'go', kind: 'navigate', url: { input: 'destination' }, next: 'check' },
      {
        id: 'check',
        kind: 'assert',
        condition: {
          kind: 'browser',
          state: { url: { input: 'destination' }, title: 'Destination' },
        },
        next: 'done',
      },
      { id: 'done', kind: 'complete' },
    ],
  };
  const destination = 'https://example.test/private/path?secret=1';
  const result = await new TaskRuntime(engine).run(program, { destination });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['navigated', 'asserted', 'completed']);
  assert.equal(JSON.stringify(result.trace).includes(destination), false);
});

test('navigate fails closed when the engine has no browser navigator', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return []; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const program: TaskProgram = {
    version: 1,
    entry: 'go',
    steps: [
      {
        id: 'go',
        kind: 'navigate',
        url: 'https://example.test/',
        next: 'done',
        onFailure: 'failed',
      },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };
  const result = await new TaskRuntime(engine).run(program, {}, { maxConsecutiveNoProgress: 10 });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['failed', 'failed']);
});
