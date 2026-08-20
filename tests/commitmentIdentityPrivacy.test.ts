import test from 'node:test';
import assert from 'node:assert/strict';
import type { BrowserStateSnapshot } from '../src/browser/browserState.js';
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
    'Reference ID: sk-example-secret-1234567890123456',
    'Reference ID: ghp_ExampleToken12345678901234567890',
    'Reference ID: https://private.example/token',
    'Reference ID: eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturepart',
  ]));
  assert.deepEqual(identity.identifiers, []);
});

test('spaced and compact financial credential shapes are not retained', () => {
  const identity = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Reference number: 4111 1111 1111 1111',
    'Reference number: 123456789012345678901234',
    'Reference ID: DE89370400440532013000',
    'Reference ID: DE89 3704 0044 0532 0130 00',
  ]));
  assert.deepEqual(identity.identifiers, []);
});

test('short legitimate identifiers are not rejected merely for sharing a secret prefix', () => {
  const identity = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Order reference: SK-42',
  ]));
  assert.deepEqual(identity.identifiers, [{ type: 'order', value: 'SK-42' }]);
});

test('ordinary bounded synthetic references remain available', () => {
  const identity = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Order reference: ORD-2026-0042',
  ]));
  assert.deepEqual(identity.identifiers, [{ type: 'order', value: 'ORD-2026-0042' }]);
});

test('opaque null origins are treated as unknown provider identity', () => {
  const browserState: BrowserStateSnapshot = {
    url: 'about:blank', origin: 'null', title: '', readyState: 'complete', historyLength: 1, timeOrigin: 1,
  };
  const identity = snapshotBrowserCommitmentIdentity('purchase', documentWith([
    'Order reference: ORD-42',
  ]), browserState);
  assert.equal(identity.origin, undefined);
});
