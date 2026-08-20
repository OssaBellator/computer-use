import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime, type TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import type { TaskProgram } from '../src/agent/taskProgram.js';
import type { DocumentContentSnapshot } from '../src/browser/documentContent.js';
import type { InteractionNode } from '../src/types.js';

function node(): InteractionNode {
  return {
    id: 'commit', frameId: 'main', role: 'button', name: 'Place order',
    focused: false, disabled: false, focusable: true, clickable: true,
    editable: false, scrollable: false, capabilities: ['activate'], interactionConfidence: 1,
  };
}

function documentWith(texts: readonly string[]): DocumentContentSnapshot {
  return {
    frames: [{ frameId: 'main', title: 'Synthetic fixture', includedBlocks: texts.length, browserExtractionTruncated: false }],
    blocks: texts.map((text, index) => ({ id: `main:p:${index}`, frameId: 'main', kind: 'paragraph', tagName: 'p', depth: 1, text, rendered: true, inViewport: true, truncated: false })),
    totalTextBytes: texts.join('').length, truncated: false, frameErrors: [],
  };
}

function reviewDocument(): DocumentContentSnapshot {
  return documentWith(['Review your order', 'Order total AUD 49.95', 'Merchant: Synthetic Shop']);
}

function program(onFailure?: string): TaskProgram {
  return {
    version: 1, name: 'synthetic-verification', entry: 'commit',
    steps: [
      { id: 'commit', kind: 'activate', target: { role: 'button', name: 'Place order' }, next: 'done', ...(onFailure ? { onFailure } : {}) },
      { id: 'done', kind: 'complete' },
      ...(onFailure ? [{ id: onFailure, kind: 'fail' as const }] : []),
    ],
  };
}

test('synthetic confirmation can override weak low-level action verification', async () => {
  let phase: 'review' | 'confirmed' = 'review';
  let activations = 0;
  const state = [node()];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async documentContent() { return phase === 'review' ? reviewDocument() : documentWith(['Order confirmed', 'Order total AUD 49.95', 'Merchant: Synthetic Shop']); },
    async activate() { activations += 1; phase = 'confirmed'; return { status: 'unverified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };
  const result = await new TaskRuntime(engine).run(program(), {}, {
    approve: async () => true,
    commitmentVerificationMaxPolls: 1,
  });
  assert.equal(result.status, 'completed');
  assert.equal(activations, 1);
  assert.equal(result.trace[0]?.outcome, 'commitment-confirmed');
  assert.equal(result.trace[0]?.actionStatus, 'unverified');
});

test('synthetic pending result terminates without following onFailure', async () => {
  let phase: 'review' | 'pending' = 'review';
  let activations = 0;
  const state = [node()];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async documentContent() { return phase === 'review' ? reviewDocument() : documentWith(['Order pending', 'Order total AUD 49.95']); },
    async activate() { activations += 1; phase = 'pending'; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };
  const result = await new TaskRuntime(engine).run(program('retry'), {}, {
    approve: async () => true,
    commitmentVerificationMaxPolls: 1,
  });
  assert.equal(result.status, 'side-effect-pending');
  assert.equal(activations, 1);
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0]?.outcome, 'commitment-pending');
});

test('synthetic missing result evidence terminates unverified without retry', async () => {
  let phase: 'review' | 'unknown' = 'review';
  let activations = 0;
  const state = [node()];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async documentContent() { return phase === 'review' ? reviewDocument() : documentWith(['Synthetic dashboard', 'Profile saved']); },
    async activate() { activations += 1; phase = 'unknown'; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };
  const result = await new TaskRuntime(engine).run(program('retry'), {}, {
    approve: async () => true,
    commitmentVerificationMaxPolls: 1,
  });
  assert.equal(result.status, 'side-effect-unverified');
  assert.equal(activations, 1);
  assert.equal(result.trace[0]?.outcome, 'commitment-unverified');
});

test('synthetic material mismatch exposes field name but not values in trace', async () => {
  let phase: 'review' | 'confirmed' = 'review';
  let observedAmount;
  const state = [node()];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async documentContent() { return phase === 'review' ? reviewDocument() : documentWith(['Order confirmed', 'Order total AUD 59.95', 'Merchant: Synthetic Shop']); },
    async activate() { phase = 'confirmed'; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };
  const result = await new TaskRuntime(engine).run(program('retry'), {}, {
    approve: async () => true,
    commitmentVerificationMaxPolls: 1,
    onCommitmentVerification: async ({ verification }) => { observedAmount = verification.observed.amount?.value; },
  });
  assert.equal(result.status, 'side-effect-mismatch');
  assert.equal(observedAmount, '59.95');
  assert.deepEqual(result.trace[0]?.commitmentMismatchedFields, ['amount']);
  const trace = JSON.stringify(result.trace);
  assert.equal(trace.includes('49.95'), false);
  assert.equal(trace.includes('59.95'), false);
  assert.equal(trace.includes('synthetic shop'), false);
});

test('synthetic declined and canceled results terminate distinctly', async () => {
  for (const [text, expectedStatus, expectedOutcome] of [
    ['Payment declined', 'side-effect-declined', 'commitment-declined'],
    ['Order canceled', 'side-effect-canceled', 'commitment-canceled'],
  ] as const) {
    let phase: 'review' | 'result' = 'review';
    let activations = 0;
    const state = [node()];
    const engine: TaskRuntimeEngine = {
      async refresh() { return state; },
      async documentContent() { return phase === 'review' ? reviewDocument() : documentWith([text]); },
      async activate() { activations += 1; phase = 'result'; return { status: 'verified', target: state[0]! }; },
      async typeInto() { throw new Error('not used'); },
    };
    const result = await new TaskRuntime(engine).run(program('retry'), {}, {
      approve: async () => true,
      commitmentVerificationMaxPolls: 1,
    });
    assert.equal(result.status, expectedStatus);
    assert.equal(result.trace[0]?.outcome, expectedOutcome);
    assert.equal(activations, 1);
  }
});

test('pre-existing synthetic success result blocks dispatch instead of proving a new side effect', async () => {
  let documentCalls = 0;
  let activations = 0;
  const state = [node()];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async documentContent() {
      documentCalls += 1;
      return documentCalls === 1
        ? reviewDocument()
        : documentWith(['Order confirmed', 'Order total AUD 49.95', 'Merchant: Synthetic Shop']);
    },
    async activate() { activations += 1; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };
  const result = await new TaskRuntime(engine).run(program(), {}, {
    approve: async () => true,
    commitmentVerificationMaxPolls: 1,
  });
  assert.equal(result.status, 'policy-blocked');
  assert.equal(activations, 0);
  assert.equal(result.trace[0]?.outcome, 'policy-blocked');
  assert.equal(result.trace[0]?.commitmentVerificationStatus, 'confirmed');
});

test('missing fresh result channel blocks detected commitment before dispatch', async () => {
  let activations = 0;
  const state = [node()];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async activate() { activations += 1; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };
  const result = await new TaskRuntime(engine).run(program(), {}, {
    approve: async () => true,
  });
  assert.equal(result.status, 'policy-blocked');
  assert.equal(activations, 0);
});

test('post-commit verification can be explicitly disabled for compatibility', async () => {
  let activations = 0;
  const state = [node()];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async activate() { activations += 1; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };
  const result = await new TaskRuntime(engine).run(program(), {}, {
    approve: async () => true,
    commitmentVerification: 'off',
  });
  assert.equal(result.status, 'completed');
  assert.equal(activations, 1);
});
