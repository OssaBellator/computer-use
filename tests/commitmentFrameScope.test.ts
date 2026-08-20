import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskRuntime, type TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import type { TaskProgram } from '../src/agent/taskProgram.js';
import type { DocumentContentSnapshot } from '../src/browser/documentContent.js';
import type { InteractionNode } from '../src/types.js';

function confirm(frameId: string): InteractionNode {
  return {
    id: `${frameId}:confirm`,
    frameId,
    role: 'button',
    name: 'Confirm',
    focused: false,
    disabled: false,
    focusable: true,
    clickable: true,
    editable: false,
    scrollable: false,
    capabilities: ['activate'],
    interactionConfidence: 1,
  };
}

function crossFrameDocument(): DocumentContentSnapshot {
  return {
    frames: [
      { frameId: 'main', title: 'Profile', includedBlocks: 1, browserExtractionTruncated: false },
      { frameId: 'checkout-frame', title: 'Checkout', includedBlocks: 3, browserExtractionTruncated: false },
    ],
    blocks: [
      {
        id: 'main:p:0', frameId: 'main', kind: 'paragraph', tagName: 'p', depth: 1,
        text: 'Profile settings', rendered: true, inViewport: true, truncated: false,
      },
      {
        id: 'checkout:p:0', frameId: 'checkout-frame', kind: 'paragraph', tagName: 'p', depth: 1,
        text: 'Review your order', rendered: true, inViewport: true, truncated: false,
      },
      {
        id: 'checkout:p:1', frameId: 'checkout-frame', kind: 'paragraph', tagName: 'p', depth: 1,
        text: 'Order total AUD 88.00', rendered: true, inViewport: true, truncated: false,
      },
      {
        id: 'checkout:p:2', frameId: 'checkout-frame', kind: 'paragraph', tagName: 'p', depth: 1,
        text: 'Payment method Test Card', rendered: true, inViewport: true, truncated: false,
      },
    ],
    totalTextBytes: 100,
    truncated: false,
    frameErrors: [],
  };
}

const program: TaskProgram = {
  version: 1,
  entry: 'confirm',
  steps: [
    { id: 'confirm', kind: 'activate', target: { role: 'button', name: 'Confirm' }, next: 'done' },
    { id: 'done', kind: 'complete' },
  ],
};

test('commitment corroboration ignores unrelated document content in another frame', async () => {
  let activations = 0;
  const state = [confirm('main')];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async documentContent() { return crossFrameDocument(); },
    async activate() { activations += 1; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };

  const result = await new TaskRuntime(engine).run(program);
  assert.equal(result.status, 'completed');
  assert.equal(activations, 1);
  assert.equal(result.trace[0]?.commitmentStatus, undefined);
});

test('the same checkout evidence gates Confirm when it belongs to the target frame', async () => {
  let activations = 0;
  const state = [confirm('checkout-frame')];
  const engine: TaskRuntimeEngine = {
    async refresh() { return state; },
    async documentContent() { return crossFrameDocument(); },
    async activate() { activations += 1; return { status: 'verified', target: state[0]! }; },
    async typeInto() { throw new Error('not used'); },
  };

  const result = await new TaskRuntime(engine).run(program);
  assert.equal(result.status, 'policy-blocked');
  assert.equal(activations, 0);
  assert.equal(result.trace[0]?.commitmentKind, 'purchase');
});
