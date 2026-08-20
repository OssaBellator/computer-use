import test from 'node:test';
import assert from 'node:assert/strict';
import {
  detectBrowserCommitment,
  markBrowserCommitmentContextUnavailable,
} from '../src/browser/commitmentDetector.js';
import type { DocumentContentSnapshot } from '../src/browser/documentContent.js';
import type { InteractionNode } from '../src/types.js';

function button(name: string, overrides: Partial<InteractionNode> = {}): InteractionNode {
  return {
    id: 'target',
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

function documentWith(
  texts: readonly string[],
  overrides: Partial<DocumentContentSnapshot> = {},
): DocumentContentSnapshot {
  return {
    frames: [{ frameId: 'main', title: 'Checkout', includedBlocks: texts.length, browserExtractionTruncated: false }],
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
    ...overrides,
  };
}

test('strong purchase labels are detected and expose bounded structured summary fields', () => {
  const result = detectBrowserCommitment({
    action: 'activate',
    target: button('Place order'),
    document: documentWith([
      'Review your order',
      'Order total AUD 129.00',
      'Merchant: Example Store',
      'Payment method: Visa ending 42',
    ]),
  });

  assert.equal(result.status, 'detected');
  assert.equal(result.confidence, 'high');
  assert.equal(result.kind, 'purchase');
  assert.equal(result.commitmentClass, 'financial');
  assert.equal(result.requiresApproval, true);
  assert.equal(result.amount?.currency, 'AUD');
  assert.equal(result.amount?.value, '129.00');
  assert.equal(result.counterparty, 'example store');
  assert.ok(result.evidence.some((item) => item.code === 'strong-target-label'));
  assert.ok(result.evidence.some((item) => item.code === 'amount-visible'));
});

test('generic submit stays uncertain without context and clears when bounded context is benign', () => {
  const target = button('Submit');
  const withoutContext = detectBrowserCommitment({ action: 'activate', target });
  assert.equal(withoutContext.status, 'uncertain');
  assert.equal(withoutContext.needsDocumentContext, true);
  assert.equal(withoutContext.requiresApproval, false);

  const benign = detectBrowserCommitment({
    action: 'activate',
    target,
    document: documentWith(['Profile settings', 'Email address']),
  });
  assert.equal(benign.status, 'none');
  assert.equal(benign.requiresApproval, false);
});

test('ambiguous confirm is promoted only when document context corroborates a commitment', () => {
  const result = detectBrowserCommitment({
    action: 'activate',
    target: button('Confirm'),
    document: documentWith([
      'Review your order',
      'Order total $59.99',
      'Payment method card',
    ]),
  });
  assert.equal(result.status, 'detected');
  assert.equal(result.kind, 'purchase');
  assert.equal(result.confidence, 'medium');
  assert.equal(result.requiresApproval, true);
});

test('incomplete context for an ambiguous action fails closed through approval', () => {
  const result = detectBrowserCommitment({
    action: 'activate',
    target: button('Confirm'),
    document: documentWith(['Profile settings'], { truncated: true }),
  });
  assert.equal(result.status, 'uncertain');
  assert.equal(result.documentContext, 'incomplete');
  assert.equal(result.requiresApproval, true);
  assert.ok(result.evidence.some((item) => item.code === 'document-context-incomplete'));
});

test('destructive, identity-security, publish, and process targets get distinct commitment classes', () => {
  const cases = [
    ['Delete account', 'destructive', 'remote-reversible'],
    ['Change password', 'identity-security', 'identity-security'],
    ['Publish', 'publish', 'remote-publish'],
    ['Run workflow', 'process-trigger', 'process-trigger'],
  ] as const;
  for (const [name, kind, commitmentClass] of cases) {
    const result = detectBrowserCommitment({ action: 'activate', target: button(name) });
    assert.equal(result.status, 'detected');
    assert.equal(result.kind, kind);
    assert.equal(result.commitmentClass, commitmentClass);
    assert.equal(result.requiresApproval, true);
  }
});

test('word-boundary matching avoids treating Unpublish as Publish', () => {
  const result = detectBrowserCommitment({ action: 'activate', target: button('Unpublish') });
  assert.equal(result.status, 'none');
  assert.equal(result.requiresApproval, false);
});

test('document extraction failure can escalate an uncertain target without inventing a kind', () => {
  const initial = detectBrowserCommitment({ action: 'activate', target: button('Confirm') });
  const failed = markBrowserCommitmentContextUnavailable(initial);
  assert.equal(failed.status, 'uncertain');
  assert.equal(failed.kind, undefined);
  assert.equal(failed.documentContext, 'unavailable');
  assert.equal(failed.requiresApproval, true);
});
