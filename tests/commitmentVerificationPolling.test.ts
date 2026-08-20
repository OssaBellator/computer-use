import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyTaskStepCommitment } from '../src/agent/commitmentVerification.js';
import type { TaskObservation } from '../src/agent/taskObservation.js';
import type { TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import type { BrowserCommitmentSummary } from '../src/browser/commitmentDetector.js';
import type { DocumentContentSnapshot } from '../src/browser/documentContent.js';
import type { InteractionNode } from '../src/types.js';

function target(): InteractionNode {
  return {
    id: 'commit', frameId: 'main', role: 'button', name: 'Place order',
    focused: false, disabled: false, focusable: true, clickable: true,
    editable: false, scrollable: false, capabilities: ['activate'], interactionConfidence: 1,
  };
}

const approved: BrowserCommitmentSummary = {
  status: 'detected', confidence: 'high', requiresApproval: true,
  needsDocumentContext: false, documentContext: 'available',
  kind: 'purchase', commitmentClass: 'financial',
  target: { id: 'commit', role: 'button', label: 'Place order' },
  amount: { text: 'AUD 20.00', currency: 'AUD', value: '20.00' },
  counterparty: 'synthetic shop', recurrence: 'unknown',
  irreversible: false, securitySensitive: false, evidence: [],
};

function observation(): TaskObservation {
  const nodes = [target()];
  return { nodes, fingerprint: 'before' };
}

function document(frames: Readonly<Record<string, readonly string[]>>): DocumentContentSnapshot {
  const frameEntries = Object.entries(frames);
  return {
    frames: frameEntries.map(([frameId, texts]) => ({ frameId, title: frameId, includedBlocks: texts.length, browserExtractionTruncated: false })),
    blocks: frameEntries.flatMap(([frameId, texts]) => texts.map((text, index) => ({
      id: `${frameId}:p:${index}`, frameId, kind: 'paragraph' as const, tagName: 'p', depth: 1,
      text, rendered: true, inViewport: true, truncated: false,
    }))),
    totalTextBytes: frameEntries.flatMap(([, texts]) => texts).join('').length,
    truncated: false,
    frameErrors: [],
  };
}

test('unrelated frame result text cannot confirm the target-frame commitment', async () => {
  const engine: TaskRuntimeEngine = {
    async refresh() { return [target()]; },
    async documentContent() {
      return document({
        main: ['Synthetic dashboard'],
        checkoutChild: ['Order confirmed', 'Order total AUD 20.00', 'Merchant: Synthetic Shop'],
      });
    },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const result = await verifyTaskStepCommitment(
    engine,
    approved,
    { id: 'commit', kind: 'activate', target: { role: 'button', name: 'Place order' }, next: 'done' },
    observation(),
    { maxPolls: 1, pollIntervalMs: 0 },
  );
  assert.equal(result.status, 'unknown');
});

test('bounded polling can observe pending state settle to confirmation without redispatch', async () => {
  let calls = 0;
  const engine: TaskRuntimeEngine = {
    async refresh() { return [target()]; },
    async documentContent() {
      calls += 1;
      return calls === 1
        ? document({ main: ['Order pending', 'Order total AUD 20.00'] })
        : document({ main: ['Order confirmed', 'Order total AUD 20.00', 'Merchant: Synthetic Shop'] });
    },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const result = await verifyTaskStepCommitment(
    engine,
    approved,
    { id: 'commit', kind: 'activate', target: { role: 'button', name: 'Place order' }, next: 'done' },
    observation(),
    { maxPolls: 2, pollIntervalMs: 0 },
  );
  assert.equal(result.status, 'confirmed');
  assert.equal(calls, 2);
});
