import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserStateSnapshot } from '../src/browser/browserState.js';
import type { BrowserCommitmentSummary } from '../src/browser/commitmentDetector.js';
import {
  evaluateBrowserCommitmentIdentity,
  snapshotBrowserCommitmentIdentity,
} from '../src/browser/commitmentIdentity.js';
import { verifyBrowserCommitment } from '../src/browser/commitmentVerifier.js';
import type { DocumentContentSnapshot } from '../src/browser/documentContent.js';

function documentWith(texts: readonly string[]): DocumentContentSnapshot {
  return {
    frames: [{ frameId: 'main', title: 'Synthetic', includedBlocks: texts.length, browserExtractionTruncated: false }],
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

function state(origin: string, timeOrigin = 1): BrowserStateSnapshot {
  return {
    url: `${origin}/synthetic`, origin, title: 'Synthetic', readyState: 'complete',
    historyLength: 1, timeOrigin,
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

function identity(
  baselineTexts: readonly string[], baselineOrigin: string,
  currentTexts: readonly string[], currentOrigin: string,
) {
  return evaluateBrowserCommitmentIdentity(
    snapshotBrowserCommitmentIdentity('purchase', documentWith(baselineTexts), state(baselineOrigin)),
    snapshotBrowserCommitmentIdentity('purchase', documentWith(currentTexts), state(currentOrigin, 2)),
  );
}

const receiptTerms = ['Order confirmed', 'Order total: AUD 20.00', 'Merchant: Synthetic Shop'];

test('same-origin phrase-only confirmation is explicitly partial', () => {
  const current = documentWith(receiptTerms);
  const result = verifyBrowserCommitment(approved, current, {
    identity: identity(['Review your order'], 'https://shop.example', receiptTerms, 'https://shop.example'),
  });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.confidence, 'medium');
  assert.equal(result.identity?.relation, 'unbound');
});

test('fresh same-origin result identity strengthens explicit confirmation', () => {
  const currentTexts = [...receiptTerms, 'Order number: ORD-NEW-42'];
  const current = documentWith(currentTexts);
  const result = verifyBrowserCommitment(approved, current, {
    identity: identity(['Review your order'], 'https://shop.example', currentTexts, 'https://shop.example'),
  });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.confidence, 'high');
  assert.equal(result.identity?.relation, 'fresh-result-identity');
});

test('cross-origin confirmation requires an exact pre-dispatch identifier match', () => {
  const currentTexts = [...receiptTerms, 'Confirmation number: REF-42'];
  const result = verifyBrowserCommitment(approved, documentWith(currentTexts), {
    identity: identity(
      ['Review your order', 'Order reference: REF-42'],
      'https://shop.example',
      currentTexts,
      'https://payments.example',
    ),
  });
  assert.equal(result.status, 'confirmed');
  assert.equal(result.confidence, 'high');
  assert.equal(result.identity?.relation, 'matched-expected');
  assert.equal(result.identity?.providerRelation, 'origin-changed');
});

test('fresh but unbound identifier cannot prove a cross-provider success page', () => {
  const currentTexts = [...receiptTerms, 'Confirmation number: OTHER-900'];
  const result = verifyBrowserCommitment(approved, documentWith(currentTexts), {
    identity: identity(
      ['Review your order'],
      'https://shop.example',
      currentTexts,
      'https://payments.example',
    ),
  });
  assert.equal(result.status, 'unknown');
  assert.ok(result.evidence.some((item) => item.code === 'provider-handoff-unbound'));
});

test('conflicting durable identifier fails even on a success-looking receipt', () => {
  const currentTexts = [...receiptTerms, 'Order number: ORD-OTHER'];
  const result = verifyBrowserCommitment(approved, documentWith(currentTexts), {
    identity: identity(
      ['Order number: ORD-EXPECTED'],
      'https://shop.example',
      currentTexts,
      'https://shop.example',
    ),
  });
  assert.equal(result.status, 'mismatch');
  assert.equal(result.identity?.relation, 'conflict');
  assert.deepEqual(result.mismatchedFields, []);
});

test('declined result remains observable across an unbound provider handoff', () => {
  const currentTexts = ['Payment declined'];
  const result = verifyBrowserCommitment(approved, documentWith(currentTexts), {
    identity: identity(
      ['Review your order'],
      'https://shop.example',
      currentTexts,
      'https://payments.example',
    ),
  });
  assert.equal(result.status, 'declined');
});
