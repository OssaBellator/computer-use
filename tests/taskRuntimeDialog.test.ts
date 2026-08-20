import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime, evaluateTaskPredicate, type TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import type { TaskProgram } from '../src/agent/taskProgram.js';
import type { BrowserDialogState } from '../src/browser/dialogController.js';

test('dialog predicates observe modal type without depending on page-provided message text', () => {
  const dialog: BrowserDialogState = { open: true, type: 'confirm', sequence: 7 };
  assert.equal(evaluateTaskPredicate({ kind: 'dialog', state: { open: true, type: 'confirm' } }, [], {}, undefined, dialog), true);
  assert.equal(evaluateTaskPredicate({ kind: 'dialog', state: { open: false } }, [], {}, undefined, dialog), false);
  assert.equal(evaluateTaskPredicate({ kind: 'dialog', state: { open: false } }, []), true);
});

test('runtime can handle a modal even when DOM and Runtime observation channels are blocked', async () => {
  let dialog: BrowserDialogState | undefined = { open: true, type: 'prompt', sequence: 1 };
  let handledPrompt: string | undefined;
  const engine: TaskRuntimeEngine = {
    async prepare() {},
    async refresh() { if (dialog) throw new Error('page blocked by modal'); return []; },
    async browserState() { if (dialog) throw new Error('execution context blocked'); return undefined; },
    dialogState() { return dialog; },
    async handleDialog(accept, promptText) {
      handledPrompt = promptText;
      const current = dialog;
      dialog = undefined;
      return current
        ? { status: 'handled', accepted: accept, type: current.type, sequence: current.sequence }
        : { status: 'no-dialog', accepted: accept };
    },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const program: TaskProgram = {
    version: 1,
    entry: 'answer',
    inputs: ['answer'],
    steps: [
      { id: 'answer', kind: 'handle-dialog', accept: true, promptText: { input: 'answer' }, next: 'verify' },
      { id: 'verify', kind: 'assert', condition: { kind: 'dialog', state: { open: false } }, next: 'done' },
      { id: 'done', kind: 'complete' },
    ],
  };
  const result = await new TaskRuntime(engine).run(program, { answer: 'trusted response' });
  assert.equal(result.status, 'completed');
  assert.equal(handledPrompt, 'trusted response');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['dialog-handled', 'asserted', 'completed']);
  assert.equal(JSON.stringify(result.trace).includes('trusted response'), false);
});

test('dialog handling fails through predeclared recovery when no controller is available', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return []; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const program: TaskProgram = {
    version: 1,
    entry: 'dismiss',
    steps: [
      { id: 'dismiss', kind: 'handle-dialog', accept: false, next: 'done', onFailure: 'failed' },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };
  const result = await new TaskRuntime(engine).run(program, {}, { maxConsecutiveNoProgress: 10 });
  assert.equal(result.status, 'failed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['failed', 'failed']);
});
