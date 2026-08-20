import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserCommitmentSummary } from '../src/browser/commitmentDetector.js';
import { verifyBrowserCommitment } from '../src/browser/commitmentVerifier.js';
import type { DocumentContentSnapshot } from '../src/browser/documentContent.js';

function documentWith(texts: readonly string[], options: { truncated?: boolean } = {}): DocumentContentSnapshot {
  return {
    frames: [{ frameId: 'main', title: 'Result', includedBlocks: texts.length, browserExtractionTruncated: false }],
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
    truncated: options.truncated ?? false,
    frameErrors: [],
  };
}

function approved(overrides: Partial<BrowserCommitmentSummary> = {}): BrowserCommitmentSummary {
  return {
    status: 'detected',
    confidence: 'high',
    requiresApproval: true,
    needsDocumentContext: false,
    documentContext: 'available',
    kind: 'purchase',
    commitmentClass: 'financial',
    target: { id: 'confirm', role: 'button', label: 'Place order' },
    amount: { text: 'AUD 49.95', currency: 'AUD', value: '49.95' },
    counterparty: 'example shop',
    recurrence: 'unknown',
    irreversible: false,
    securitySensitive: false,
    evidence: [],
    ...overrides,
  };
}

test('explicit purchase receipt confirms matching approved terms', () => {
  const result = verifyBrowserCommitment(approved(), documentWith([
    'Order confirmed',
    'Order total: AUD 49.95',
    'Merchant: Example Shop',
  ]));
  assert.equal(result.status, 'confirmed');
  assert.equal(result.confidence, 'high');
  assert.deepEqual(result.mismatchedFields, []);
  assert.equal(result.observed.amount?.value, '49.95');
  assert.equal(result.observed.counterparty, 'example shop');
});

test('pending payment remains pending rather than being treated as success', () => {
  const result = verifyBrowserCommitment(approved(), documentWith([
    'Payment processing',
    'Order total: AUD 49.95',
    'Merchant: Example Shop',
  ]));
  assert.equal(result.status, 'pending');
});

test('declined and canceled outcomes are distinct terminal results', () => {
  const declined = verifyBrowserCommitment(approved(), documentWith(['Payment declined']));
  const canceled = verifyBrowserCommitment(approved(), documentWith(['Order cancelled']));
  assert.equal(declined.status, 'declined');
  assert.equal(canceled.status, 'canceled');
});

test('material amount mismatch overrides a success-looking receipt', () => {
  const result = verifyBrowserCommitment(approved(), documentWith([
    'Order confirmed',
    'Order total: AUD 59.95',
    'Merchant: Example Shop',
  ]));
  assert.equal(result.status, 'mismatch');
  assert.deepEqual(result.mismatchedFields, ['amount']);
});

test('different explicit currency codes are material mismatches', () => {
  const result = verifyBrowserCommitment(approved(), documentWith([
    'Payment successful',
    'Order total: USD 49.95',
    'Merchant: Example Shop',
  ]));
  assert.equal(result.status, 'mismatch');
  assert.deepEqual(result.mismatchedFields, ['currency']);
});

test('ambiguous currency symbols do not create a false mismatch against a code', () => {
  const result = verifyBrowserCommitment(approved(), documentWith([
    'Payment successful',
    'Order total: $49.95',
    'Merchant: Example Shop',
  ]));
  assert.equal(result.status, 'confirmed');
  assert.deepEqual(result.mismatchedFields, []);
});

test('generic page change without explicit outcome remains unknown', () => {
  const result = verifyBrowserCommitment(approved(), documentWith([
    'Your account dashboard',
    'Profile saved',
    'Order total: AUD 49.95',
  ]));
  assert.equal(result.status, 'unknown');
});

test('incomplete documents can confirm explicit outcomes but lower confidence', () => {
  const result = verifyBrowserCommitment(approved(), documentWith([
    'Order confirmed',
    'Order total: AUD 49.95',
  ], { truncated: true }));
  assert.equal(result.status, 'confirmed');
  assert.equal(result.confidence, 'medium');
  assert.equal(result.documentContext, 'incomplete');
});

test('Unpublished does not satisfy a published outcome', () => {
  const publication = approved({
    kind: 'publish',
    commitmentClass: 'remote-publish',
    amount: undefined,
    counterparty: undefined,
  });
  const result = verifyBrowserCommitment(publication, documentWith(['Unpublished successfully']));
  assert.equal(result.status, 'unknown');
});

test('missing document evidence is explicitly unknown', () => {
  const result = verifyBrowserCommitment(approved(), undefined);
  assert.equal(result.status, 'unknown');
  assert.equal(result.documentContext, 'unavailable');
});
