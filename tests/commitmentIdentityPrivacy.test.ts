import test from 'node:test';
import assert from 'node:assert/strict';
import { snapshotBrowserCommitmentIdentity } from '../src/browser/commitmentIdentity.js';
import type { DocumentContentSnapshot } from '../src/browser/documentContent.js';

function documentWith(texts: readonly string[]): DocumentContentSnapshot {
  return {
    frames: [{ frameId: 'main', title: 'Synthetic', includedBlocks: texts.length, browserExtractionTruncated: false }],
    blocks: texts.map((text, index) => ({
      id: `main:p:${index}`, frameId: 'main', kind: 'paragraph' as const, tagName: 'p', depth: 1,
      text, rendered: true, inViewport: true, truncated: false,
    })),
    totalTextBytes: texts.join('').length,
    truncated: false,
    frameErrors: [],
  };
}

test('generic reference labels do not retain credential-shaped identifiers or URLs', () => {
  const identity = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Reference ID: sk-example-secret-12345',
    'Reference ID: ghp_ExampleToken1234567890',
    'Reference ID: https://private.example/token',
    'Reference ID: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart',
  ]));
  assert.deepEqual(identity.identifiers, []);
});

test('spaced numeric credential-like text is not truncated into a short reference', () => {
  const identity = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Reference number: 4111 1111 1111 1111',
  ]));
  assert.deepEqual(identity.identifiers, []);
});

test('ordinary bounded synthetic references remain available', () => {
  const identity = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Order reference: ORD-2026-0042',
  ]));
  assert.deepEqual(identity.identifiers, [{ type: 'order', value: 'ORD-2026-0042' }]);
});
