import test from 'node:test';
import assert from 'node:assert/strict';
import { captureTaskStepCommitmentVerificationBaseline } from '../src/agent/commitmentVerification.js';
import type { TaskObservation } from '../src/agent/taskObservation.js';
import type { TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import type { BrowserCommitmentSummary } from '../src/browser/commitmentDetector.js';
import type { DocumentContentSnapshot } from '../src/browser/documentContent.js';
import type { InteractionNode } from '../src/types.js';

function node(id = 'commit'): InteractionNode {
  return {
    id, frameId: 'main', role: 'button', name: 'Place order',
    focused: false, disabled: false, focusable: true, clickable: true,
    editable: false, scrollable: false, capabilities: ['activate'], interactionConfidence: 1,
  };
}

function documentWith(amount: string, truncated = false): DocumentContentSnapshot {
  const texts = ['Review your order', `Order total AUD ${amount}`, 'Merchant: Synthetic Shop'];
  return {
    frames: [{ frameId: 'main', title: 'Synthetic checkout', includedBlocks: texts.length, browserExtractionTruncated: false }],
    blocks: texts.map((text, index) => ({
      id: `main:p:${index}`, frameId: 'main', kind: 'paragraph', tagName: 'p', depth: 1,
      text, rendered: true, inViewport: true, truncated: false,
    })),
    totalTextBytes: texts.join('').length,
    truncated,
    frameErrors: [],
  };
}

const approved: BrowserCommitmentSummary = {
  status: 'detected', confidence: 'high', requiresApproval: true,
  needsDocumentContext: false, documentContext: 'available',
  kind: 'purchase', commitmentClass: 'financial',
  target: { id: 'commit', role: 'button', label: 'Place order' },
  amount: { text: 'AUD 49.95', currency: 'AUD', value: '49.95' },
  counterparty: 'synthetic shop', recurrence: 'unknown',
  irreversible: false, securitySensitive: false, evidence: [],
};

function before(): TaskObservation {
  return { nodes: [node()], fingerprint: 'before' };
}

const step = {
  id: 'commit', kind: 'activate' as const,
  target: { role: 'button', name: 'Place order' }, next: 'done',
};

test('post-approval target replacement invalidates commitment verification preflight', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return [node('replacement')]; },
    async documentContent() { return documentWith('49.95'); },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const baseline = await captureTaskStepCommitmentVerificationBaseline(engine, approved, step, before());
  assert.equal(baseline, undefined);
});

test('post-approval material term change invalidates commitment verification preflight', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return [node()]; },
    async documentContent() { return documentWith('59.95'); },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const baseline = await captureTaskStepCommitmentVerificationBaseline(engine, approved, step, before());
  assert.equal(baseline, undefined);
});

test('same target and approved material terms produce a neutral dispatchable baseline', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return [node()]; },
    async documentContent() { return documentWith('49.95'); },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const baseline = await captureTaskStepCommitmentVerificationBaseline(engine, approved, step, before());
  assert.equal(baseline?.frameId, 'main');
  assert.equal(baseline?.verification.status, 'unknown');
  assert.equal(baseline?.verification.documentContext, 'available');
});

test('truncated fresh baseline remains explicitly incomplete for runtime policy blocking', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return [node()]; },
    async documentContent() { return documentWith('49.95', true); },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const baseline = await captureTaskStepCommitmentVerificationBaseline(engine, approved, step, before());
  assert.equal(baseline?.verification.status, 'unknown');
  assert.equal(baseline?.verification.documentContext, 'incomplete');
});
