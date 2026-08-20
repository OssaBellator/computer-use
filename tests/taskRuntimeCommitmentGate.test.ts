import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime, type TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import type { TaskProgram } from '../src/agent/taskProgram.js';
import type { DocumentContentSnapshot } from '../src/browser/documentContent.js';
import type { InteractionNode } from '../src/types.js';

function node(name: string, overrides: Partial<InteractionNode> = {}): InteractionNode {
  return {
    id: name.toLowerCase().replace(/\s+/g, '-'),
    frameId: 'main',
    role: 'button',
    name,
    focused: false,
    disabled: false,
    focusable: true,
    clickable: true,
    editable: false,
    scrollable: false,
    capabilities: ['activate'],
    interactionConfidence: 1,
    ...overrides,
  };
}

function documentWith(texts: readonly string[]): DocumentContentSnapshot {
  return {
    frames: [{ frameId: 'main', title: 'Review order', includedBlocks: texts.length, browserExtractionTruncated: false }],
    blocks: texts.map((text, index) => ({
      id: `main:p:${index}`,
      frameId: 'main',
      kind: 'paragraph',
      tagName: 'p',
      depth: 1,
      text,
      rendered: true,
      inViewport: true,
      truncated: false,
    })),
    totalTextBytes: texts.join('').length,
    truncated: false,
    frameErrors: [],
  };
}

function activateProgram(name: string): TaskProgram {
  return {
    version: 1,
    entry: 'act',
    steps: [
      { id: 'act', kind: 'activate', target: { role: 'button', name }, next: 'done' },
      { id: 'done', kind: 'complete' },
    ],
  };
}

test('undeclared strong commitment is blocked before browser activation', async () => {
  let activations = 0;
  const state = [node('Place order')];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async activate() { activations += 1; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };

  const result = await new TaskRuntime(engine).run(activateProgram('Place order'), {}, {
    maxRisk: 'external-side-effect',
  });
  assert.equal(result.status, 'policy-blocked');
  assert.equal(activations, 0);
  assert.equal(result.trace[0]?.commitmentStatus, 'detected');
  assert.equal(result.trace[0]?.commitmentKind, 'purchase');
  assert.equal(result.trace[0]?.commitmentConfidence, 'high');
});

test('approval receives bounded financial commitment summary before activation', async () => {
  let activations = 0;
  let documentCalls = 0;
  const state = [node('Place order')];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async documentContent() {
      documentCalls += 1;
      return documentWith(['Order total AUD 49.95', 'Merchant: Example Shop', 'Payment method card']);
    },
    async activate() { activations += 1; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };

  const result = await new TaskRuntime(engine).run(activateProgram('Place order'), {}, {
    approve: async (context) => {
      assert.equal(context.risk, 'external-side-effect');
      assert.equal(context.commitment?.kind, 'purchase');
      assert.equal(context.commitment?.amount?.currency, 'AUD');
      assert.equal(context.commitment?.amount?.value, '49.95');
      assert.equal(context.commitment?.counterparty, 'example shop');
      return true;
    },
  });
  assert.equal(result.status, 'completed');
  assert.equal(activations, 1);
  assert.equal(documentCalls, 1);
});

test('ordinary Submit remains compatible when no structured document channel exists', async () => {
  let activations = 0;
  const state = [node('Submit')];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async activate() { activations += 1; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };

  const result = await new TaskRuntime(engine).run(activateProgram('Submit'));
  assert.equal(result.status, 'completed');
  assert.equal(activations, 1);
});

test('ambiguous Confirm uses one bounded document read and blocks corroborated checkout', async () => {
  let activations = 0;
  let documentCalls = 0;
  const state = [node('Confirm')];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async documentContent(options) {
      documentCalls += 1;
      assert.equal(options?.maxBlocks, 128);
      assert.equal(options?.maxTextBytes, 32 * 1024);
      return documentWith(['Review your order', 'Order total $25.00', 'Payment method card']);
    },
    async activate() { activations += 1; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };

  const result = await new TaskRuntime(engine).run(activateProgram('Confirm'));
  assert.equal(result.status, 'policy-blocked');
  assert.equal(documentCalls, 1);
  assert.equal(activations, 0);
  assert.equal(result.trace[0]?.commitmentKind, 'purchase');
});

test('ambiguous commitment fails closed when an available document channel throws', async () => {
  let activations = 0;
  const state = [node('Confirm')];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async documentContent() { throw new Error('renderer disappeared'); },
    async activate() { activations += 1; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };

  const result = await new TaskRuntime(engine).run(activateProgram('Confirm'));
  assert.equal(result.status, 'policy-blocked');
  assert.equal(activations, 0);
  assert.equal(result.trace[0]?.commitmentStatus, 'uncertain');
});

test('focused Enter activation is subject to the same commitment gate', async () => {
  let presses = 0;
  const state = [node('Pay now', { focused: true })];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
    async pressKey() { presses += 1; return { status: 'verified' }; },
  };
  const program: TaskProgram = {
    version: 1,
    entry: 'enter',
    steps: [
      { id: 'enter', kind: 'press-key', key: 'Enter', next: 'done' },
      { id: 'done', kind: 'complete' },
    ],
  };

  const result = await new TaskRuntime(engine).run(program);
  assert.equal(result.status, 'policy-blocked');
  assert.equal(presses, 0);
  assert.equal(result.trace[0]?.commitmentKind, 'purchase');
});

test('commitment detection can be explicitly disabled for declaration-only compatibility', async () => {
  let activations = 0;
  const state = [node('Place order')];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async activate() { activations += 1; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };

  const result = await new TaskRuntime(engine).run(activateProgram('Place order'), {}, {
    commitmentDetection: 'off',
  });
  assert.equal(result.status, 'completed');
  assert.equal(activations, 1);
});
