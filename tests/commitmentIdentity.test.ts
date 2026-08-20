import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserStateSnapshot } from '../src/browser/browserState.js';
import {
  evaluateBrowserCommitmentIdentity,
  snapshotBrowserCommitmentIdentity,
} from '../src/browser/commitmentIdentity.js';
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
    url: `${origin}/synthetic`,
    origin,
    title: 'Synthetic',
    readyState: 'complete',
    historyLength: 1,
    timeOrigin,
  };
}

test('extracts only explicit bounded identifiers for the commitment kind', () => {
  const identity = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Order number: ORD-ABC-123',
    'Transaction id TXN_456',
    'Unlabelled token SHOULD-NOT-BE-CAPTURED',
  ]), state('https://shop.example'));

  assert.deepEqual(identity.identifiers, [
    { type: 'order', value: 'ORD-ABC-123' },
    { type: 'transaction', value: 'TXN_456' },
  ]);
  assert.equal(identity.origin, 'https://shop.example');
});

test('whitespace-only labels do not capture ordinary prose as identifiers', () => {
  const identity = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Order number will be assigned after payment',
    'Transaction id pending',
    'Reference number unavailable',
  ]));
  assert.deepEqual(identity.identifiers, []);
});

test('explicit separator may retain a bounded alphabetic identifier', () => {
  const identity = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Reference ID: SYNTHETIC',
  ]));
  assert.deepEqual(identity.identifiers, [{ type: 'reference', value: 'SYNTHETIC' }]);
});

test('rejects long all-digit values that could be card or account shaped', () => {
  const identity = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Reference number: 4111111111111111',
    'Order number: 1234567890123456',
  ]));
  assert.deepEqual(identity.identifiers, []);
});

test('matching value binds across different safe result labels', () => {
  const baseline = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Order reference: REF-42',
  ]), state('https://shop.example'));
  const current = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Confirmation number: REF-42',
  ]), state('https://payments.example', 2));
  const result = evaluateBrowserCommitmentIdentity(baseline, current);

  assert.equal(result.relation, 'matched-expected');
  assert.equal(result.providerRelation, 'origin-changed');
  assert.deepEqual(result.matchedTypes, ['confirmation']);
});

test('new result identifier is fresh only when the baseline contains no identifier', () => {
  const baseline = snapshotBrowserCommitmentIdentity('booking', documentWith([
    'Review reservation',
  ]), state('https://travel.example'));
  const current = snapshotBrowserCommitmentIdentity('booking', documentWith([
    'Booking number: BK-9001',
  ]), state('https://travel.example', 2));
  const result = evaluateBrowserCommitmentIdentity(baseline, current);

  assert.equal(result.relation, 'fresh-result-identity');
  assert.deepEqual(result.freshTypes, ['booking']);
});

test('same identifier category with a different value fails as conflict', () => {
  const baseline = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Order number: ORD-OLD',
  ]), state('https://shop.example'));
  const current = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Order number: ORD-OTHER',
  ]), state('https://shop.example', 2));
  const result = evaluateBrowserCommitmentIdentity(baseline, current);

  assert.equal(result.relation, 'conflict');
  assert.deepEqual(result.conflictingTypes, ['order']);
});

test('multiple historical baseline identifiers are ambiguous and never treated as expected', () => {
  const baseline = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Previous order number: ORD-OLD-1',
    'Previous order number: ORD-OLD-2',
  ]), state('https://shop.example'));
  const current = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Order confirmed',
    'Order number: ORD-OLD-1',
  ]), state('https://payments.example', 2));
  const result = evaluateBrowserCommitmentIdentity(baseline, current);

  assert.equal(result.relation, 'unbound');
  assert.deepEqual(result.matchedTypes, []);
  assert.deepEqual(result.freshTypes, []);
  assert.deepEqual(result.conflictingTypes, []);
});

test('a different result value is not fresh when a pre-dispatch identifier already existed', () => {
  const baseline = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Order number: ORD-EXPECTED',
  ]), state('https://shop.example'));
  const current = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Confirmation number: OTHER-900',
  ]), state('https://shop.example', 2));
  const result = evaluateBrowserCommitmentIdentity(baseline, current);

  assert.equal(result.relation, 'unbound');
  assert.deepEqual(result.freshTypes, []);
});
