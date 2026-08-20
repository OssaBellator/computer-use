import test from 'node:test';
import assert from 'node:assert/strict';
import { captureTaskStepCommitmentVerificationBaseline } from '../src/agent/commitmentVerification.js';
import type { TaskObservation } from '../src/agent/taskObservation.js';
import type { TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import type { BrowserCommitmentSummary } from '../src/browser/commitmentDetector.js';
import type { DocumentContentSnapshot } from '../src/browser/documentContent.js';
import type { InteractionNode } from '../src/types.js';

function childTarget(): InteractionNode {
  return {
    id: 'commit', frameId: 'checkout-frame', role: 'button', name: 'Place order',
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

function childDocument(): DocumentContentSnapshot {
  const texts = [
    'Review your order',
    'Order reference: CHILD-REF-42',
    'Order total AUD 20.00',
    'Merchant: Synthetic Shop',
  ];
  return {
    frames: [{
      frameId: 'checkout-frame', title: 'Checkout', includedBlocks: texts.length,
      browserExtractionTruncated: false,
    }],
    blocks: texts.map((text, index) => ({
      id: `checkout-frame:p:${index}`, frameId: 'checkout-frame', kind: 'paragraph' as const,
      tagName: 'p', depth: 1, text, rendered: true, inViewport: true, truncated: false,
    })),
    totalTextBytes: texts.join('').length,
    truncated: false,
    frameErrors: [],
  };
}

test('top-level browser origin is not attributed to a child-frame commitment identity', async () => {
  const node = childTarget();
  const before: TaskObservation = { nodes: [node], fingerprint: 'before' };
  const engine: TaskRuntimeEngine = {
    async refresh() { return [node]; },
    async browserState() {
      return {
        url: 'https://top.example/checkout', origin: 'https://top.example', title: 'Top',
        readyState: 'complete', historyLength: 1, timeOrigin: 1,
      };
    },
    async documentContent() { return childDocument(); },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };

  const baseline = await captureTaskStepCommitmentVerificationBaseline(
    engine,
    approved,
    { id: 'commit', kind: 'activate', target: { role: 'button', name: 'Place order' }, next: 'done' },
    before,
  );

  assert.equal(baseline?.verification.status, 'unknown');
  assert.equal(baseline?.identity?.origin, undefined);
  assert.deepEqual(baseline?.identity?.identifiers, [{ type: 'order', value: 'CHILD-REF-42' }]);
});
