import test from 'node:test';
import assert from 'node:assert/strict';
import {
  verifyTaskStepCommitment,
  type TaskCommitmentVerificationBaseline,
} from '../src/agent/commitmentVerification.js';
import type { TaskRuntimeEngine } from '../src/agent/taskRuntime.js';
import type { BrowserStateSnapshot } from '../src/browser/browserState.js';
import type { BrowserCommitmentSummary } from '../src/browser/commitmentDetector.js';
import { snapshotBrowserCommitmentIdentity } from '../src/browser/commitmentIdentity.js';
import { verifyBrowserCommitment } from '../src/browser/commitmentVerifier.js';
import type { DocumentContentSnapshot } from '../src/browser/documentContent.js';
import type { BrowserTargetSummary } from '../src/browser/targetController.js';

const approved: BrowserCommitmentSummary = {
  status: 'detected', confidence: 'high', requiresApproval: true,
  needsDocumentContext: false, documentContext: 'available',
  kind: 'purchase', commitmentClass: 'financial',
  target: { id: 'commit', role: 'button', label: 'Place order' },
  amount: { text: 'AUD 20.00', currency: 'AUD', value: '20.00' },
  counterparty: 'synthetic shop', recurrence: 'unknown',
  irreversible: false, securitySensitive: false, evidence: [],
};

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

function baseline(
  texts: readonly string[] = ['Review your order', 'Order total AUD 20.00', 'Merchant: Synthetic Shop'],
  origin = 'https://shop.example',
): TaskCommitmentVerificationBaseline {
  const document = documentWith(texts);
  const browserState = state(origin);
  return {
    frameId: 'main',
    verification: verifyBrowserCommitment(approved, document),
    identity: snapshotBrowserCommitmentIdentity('purchase', document, browserState),
    pageTargetId: 'page-1',
    pageCount: 1,
    latestPageSequence: 1,
  };
}

function topology(
  pages: number,
  latest: { targetId: string; sequence: number; openerId?: string },
): BrowserTargetSummary {
  return {
    total: pages,
    pages,
    unattachedPages: Math.max(0, pages - 1),
    latestPage: {
      targetId: latest.targetId,
      type: 'page',
      attached: false,
      sequence: latest.sequence,
      ...(latest.openerId ? { openerId: latest.openerId } : {}),
    },
  };
}

function engine(options: {
  activeDocument: DocumentContentSnapshot;
  activeState: BrowserStateSnapshot;
  targets?: BrowserTargetSummary;
  popupDocument?: DocumentContentSnapshot;
  popupState?: BrowserStateSnapshot;
}): TaskRuntimeEngine {
  return {
    async refresh() { return []; },
    async documentContent() { return options.activeDocument; },
    async browserState() { return options.activeState; },
    activePageTargetId() { return 'page-1'; },
    targetState() { return options.targets; },
    async documentContentForPage() { return options.popupDocument; },
    async browserStateForPage() { return options.popupState; },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
}

const receipt = ['Order confirmed', 'Order total AUD 20.00', 'Merchant: Synthetic Shop'];

test('same-target cross-origin redirect confirms only when reference survives handoff', async () => {
  const result = await verifyTaskStepCommitment(
    engine({
      activeDocument: documentWith([...receipt, 'Confirmation number: REF-42']),
      activeState: state('https://payments.example', 2),
    }),
    approved,
    baseline(['Review your order', 'Order reference: REF-42', 'Order total AUD 20.00', 'Merchant: Synthetic Shop']),
    { maxPolls: 1, pollIntervalMs: 0 },
  );
  assert.equal(result.status, 'confirmed');
  assert.equal(result.identity?.relation, 'matched-expected');
  assert.equal(result.identity?.providerRelation, 'origin-changed');
});

test('same-target unbound cross-origin success remains unknown', async () => {
  const result = await verifyTaskStepCommitment(
    engine({
      activeDocument: documentWith([...receipt, 'Confirmation number: NEW-42']),
      activeState: state('https://payments.example', 2),
    }),
    approved,
    baseline(),
    { maxPolls: 1, pollIntervalMs: 0 },
  );
  assert.equal(result.status, 'unknown');
});

test('one opener-bound same-origin popup can provide a fresh result identity', async () => {
  const result = await verifyTaskStepCommitment(
    engine({
      activeDocument: documentWith(['Review your order']),
      activeState: state('https://shop.example'),
      targets: topology(2, { targetId: 'popup-1', sequence: 2, openerId: 'page-1' }),
      popupDocument: documentWith([...receipt, 'Order number: ORD-9001']),
      popupState: state('https://shop.example', 2),
    }),
    approved,
    baseline(),
    { maxPolls: 1, pollIntervalMs: 0 },
  );
  assert.equal(result.status, 'confirmed');
  assert.equal(result.identity?.relation, 'fresh-result-identity');
  assert.ok(result.evidence.some((item) => item.code === 'bound-popup-result'));
});

test('unrelated new tab cannot verify even with matching success text', async () => {
  const result = await verifyTaskStepCommitment(
    engine({
      activeDocument: documentWith(['Review your order']),
      activeState: state('https://shop.example'),
      targets: topology(2, { targetId: 'other-tab', sequence: 2, openerId: 'some-other-page' }),
      popupDocument: documentWith([...receipt, 'Order number: ORD-9001']),
      popupState: state('https://shop.example', 2),
    }),
    approved,
    baseline(),
    { maxPolls: 1, pollIntervalMs: 0 },
  );
  assert.equal(result.status, 'unknown');
});

test('multiple new pages are ambiguous and none are searched for success', async () => {
  const result = await verifyTaskStepCommitment(
    engine({
      activeDocument: documentWith(['Review your order']),
      activeState: state('https://shop.example'),
      targets: topology(3, { targetId: 'popup-2', sequence: 3, openerId: 'page-1' }),
      popupDocument: documentWith([...receipt, 'Order number: ORD-9001']),
      popupState: state('https://shop.example', 2),
    }),
    approved,
    baseline(),
    { maxPolls: 1, pollIntervalMs: 0 },
  );
  assert.equal(result.status, 'unknown');
});

test('cross-origin popup must carry a reference from the approved page', async () => {
  const result = await verifyTaskStepCommitment(
    engine({
      activeDocument: documentWith(['Review your order']),
      activeState: state('https://shop.example'),
      targets: topology(2, { targetId: 'popup-1', sequence: 2, openerId: 'page-1' }),
      popupDocument: documentWith([...receipt, 'Confirmation number: REF-42']),
      popupState: state('https://payments.example', 2),
    }),
    approved,
    baseline(['Review your order', 'Order reference: REF-42', 'Order total AUD 20.00', 'Merchant: Synthetic Shop']),
    { maxPolls: 1, pollIntervalMs: 0 },
  );
  assert.equal(result.status, 'confirmed');
  assert.equal(result.identity?.relation, 'matched-expected');
});

test('different durable ID in an opener-bound popup is a mismatch', async () => {
  const result = await verifyTaskStepCommitment(
    engine({
      activeDocument: documentWith(['Review your order']),
      activeState: state('https://shop.example'),
      targets: topology(2, { targetId: 'popup-1', sequence: 2, openerId: 'page-1' }),
      popupDocument: documentWith([...receipt, 'Order number: ORD-OTHER']),
      popupState: state('https://shop.example', 2),
    }),
    approved,
    baseline(['Review your order', 'Order number: ORD-EXPECTED', 'Order total AUD 20.00', 'Merchant: Synthetic Shop']),
    { maxPolls: 1, pollIntervalMs: 0 },
  );
  assert.equal(result.status, 'mismatch');
  assert.equal(result.identity?.relation, 'conflict');
});
