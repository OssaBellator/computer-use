import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserTargetState } from '../src/browser/targetController.js';
import {
  BrowserComputerEnvironmentAdapter,
  type BrowserComputerRuntime,
} from '../src/computer/browserEnvironmentAdapter.js';
import { computerActionMayAutoRetry, type ComputerActionRequest } from '../src/computer/environmentAdapter.js';
import type { InteractionNode } from '../src/types.js';

function node(overrides: Partial<InteractionNode> = {}): InteractionNode {
  return {
    id: 'backend:41',
    structuralId: 'main:button:nth-of-type(1)',
    backendNodeId: 41,
    frameId: 'main',
    focused: false,
    disabled: false,
    rect: { x: 1, y: 1, width: 20, height: 10 },
    visibleRect: { x: 1, y: 1, width: 20, height: 10 },
    viewportVisible: true,
    mainViewportRect: { x: 1, y: 1, width: 20, height: 10 },
    mainViewportVisibleRect: { x: 1, y: 1, width: 20, height: 10 },
    mainViewportVisible: true,
    focusable: true,
    clickable: true,
    editable: false,
    scrollable: false,
    role: 'button',
    name: 'Safe action',
    capabilities: ['activate'],
    interactionConfidence: 1,
    ...overrides,
  };
}

class FakeBrowserRuntime implements BrowserComputerRuntime {
  targets: BrowserTargetState[] = [{ targetId: 'page-a', type: 'page', attached: true, sequence: 7 }];
  active = 'page-a';
  nodes: InteractionNode[] = [node()];
  documentText = 'Synthetic fixture content';
  activationResult = 'verified';
  throwOnType = false;
  activateCalls = 0;

  browserTargets(): BrowserTargetState[] { return this.targets.map((target) => ({ ...target })); }
  activePageTargetId(): string | undefined { return this.active; }
  targetState() {
    const pages = this.targets.filter((target) => target.type === 'page');
    const unattached = pages.filter((target) => !target.attached);
    return {
      total: this.targets.length,
      pages: pages.length,
      unattachedPages: unattached.length,
      latestPage: pages.at(-1),
      latestUnattachedPage: unattached.at(-1),
    };
  }
  async refresh(): Promise<InteractionNode[]> { return this.nodes.map((item) => ({ ...item })); }
  async activate(): Promise<{ status: string; target: InteractionNode | null }> {
    this.activateCalls += 1;
    return { status: this.activationResult, target: this.nodes[0] ?? null };
  }
  async hover(): Promise<{ status: string; target: InteractionNode | null }> {
    return { status: 'verified', target: this.nodes[0] ?? null };
  }
  async typeInto(): Promise<{ status: string; target: InteractionNode | null }> {
    if (this.throwOnType) throw new Error('transport failed after invocation');
    return { status: 'verified', target: this.nodes[0] ?? null };
  }
  async pressKey(): Promise<{ status: string }> { return { status: 'verified' }; }
  async scrollViewport(): Promise<{ status: string }> { return { status: 'verified' }; }
  async browserState() {
    return {
      url: 'https://example.test/',
      origin: 'https://example.test',
      title: 'fixture',
      readyState: 'complete' as const,
      historyLength: 1,
      timeOrigin: 1,
    };
  }
  async documentContent(_options?: { maxBlocks?: number; maxTextBytes?: number; maxDepth?: number }) {
    const text = this.documentText;
    return {
      frames: [{ frameId: 'main', title: 'fixture', includedBlocks: 1, browserExtractionTruncated: false }],
      blocks: [{ id: 'main:p:1', frameId: 'main', kind: 'paragraph' as const, tagName: 'p', depth: 1, text, rendered: true, inViewport: true, truncated: false }],
      totalTextBytes: Buffer.byteLength(text),
      truncated: false,
      frameErrors: [],
    };
  }
  async documentContentForPage(_targetId: string, options?: { maxBlocks?: number; maxTextBytes?: number; maxDepth?: number }) {
    return this.documentContent(options);
  }
}

function localAction(adapter: BrowserComputerEnvironmentAdapter, capability: string, target = adapter.entityForNode(node())): ComputerActionRequest {
  return {
    adapterId: adapter.descriptor.id,
    actionId: 'test-action',
    capability,
    effect: 'local-reversible',
    idempotency: 'idempotent',
    target,
  };
}

test('browser computer adapter preserves stable surface and target identity', async () => {
  const runtime = new FakeBrowserRuntime();
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const first = adapter.currentSurface();
  const second = adapter.currentSurface();
  assert.deepEqual(first, second);
  assert.equal(first?.surfaceId, 'page-a');
  assert.equal(first?.generation, 7);

  const observed = await adapter.observe({ adapterId: adapter.descriptor.id, channel: 'semantic-ui', surface: first, limits: { maxItems: 5, maxTextBytes: 256 } });
  const item = (observed.data as Array<{ entity: { entityId: string; surfaceId?: string; generation?: number } }>)[0];
  assert.equal(item.entity.entityId, 'main:backend:41');
  assert.equal(item.entity.surfaceId, 'page-a');
  assert.equal(item.entity.generation, 7);
});

test('browser computer adapter rejects stale generation before observation or action dispatch', async () => {
  const runtime = new FakeBrowserRuntime();
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const surface = adapter.currentSurface()!;
  const entity = adapter.entityForNode(runtime.nodes[0], surface);
  runtime.targets = [{ targetId: 'page-a', type: 'page', attached: true, sequence: 8 }];

  await assert.rejects(
    adapter.observe({ adapterId: adapter.descriptor.id, channel: 'semantic-ui', surface }),
    /generation-mismatch/,
  );
  const result = await adapter.act(localAction(adapter, 'browser.hover', entity));
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(result.status, 'rejected');
});

test('browser computer adapter preserves non-latest target identity from the full target list', () => {
  const runtime = new FakeBrowserRuntime();
  runtime.targets = [
    { targetId: 'page-a', type: 'page', attached: true, sequence: 7 },
    { targetId: 'page-b', type: 'page', attached: false, sequence: 8 },
  ];
  runtime.active = 'page-a';
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const surface = adapter.currentSurface();
  assert.equal(surface?.surfaceId, 'page-a');
  assert.equal(surface?.generation, 7);
});

test('browser computer adapter bounds semantic observations and reports truncation', async () => {
  const runtime = new FakeBrowserRuntime();
  runtime.nodes = [
    node({ backendNodeId: 1, id: 'backend:1', name: 'abcdefghij' }),
    node({ backendNodeId: 2, id: 'backend:2', name: 'klmnopqrst' }),
  ];
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const observed = await adapter.observe({
    adapterId: adapter.descriptor.id,
    channel: 'semantic-ui',
    surface: adapter.currentSurface(),
    limits: { maxItems: 1, maxTextBytes: 5 },
  });
  const data = observed.data as Array<{ name?: string }>;
  assert.equal(data.length, 1);
  assert.equal(data[0].name, 'abcde');
  assert.equal(observed.truncated, true);
  assert.equal(observed.complete, false);
});

test('browser computer adapter supports verified read-only no-op semantics', async () => {
  const runtime = new FakeBrowserRuntime();
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const result = await adapter.act({
    adapterId: adapter.descriptor.id,
    actionId: 'observe-noop',
    capability: 'browser.semantic-ui.observe',
    effect: 'observe-only',
    idempotency: 'read-only',
  });
  assert.deepEqual(result, {
    status: 'completed',
    dispatch: 'not-dispatched',
    verification: 'verified',
    evidence: ['browser.verified-noop'],
  });
});

test('browser computer adapter reports definite pre-dispatch failure for stale target', async () => {
  const runtime = new FakeBrowserRuntime();
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const target = adapter.entityForNode(runtime.nodes[0], adapter.currentSurface());
  runtime.nodes = [];
  const result = await adapter.act(localAction(adapter, 'browser.hover', target));
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(result.verification, 'not-applicable');
});

test('browser computer adapter converts adapter exception after invocation into unknown dispatch and blocks retry', async () => {
  const runtime = new FakeBrowserRuntime();
  runtime.throwOnType = true;
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const request = {
    ...localAction(adapter, 'browser.type'),
    payload: { text: 'synthetic' },
  };
  const result = await adapter.act(request);
  assert.equal(result.status, 'unknown');
  assert.equal(result.dispatch, 'unknown');
  assert.equal(result.verification, 'unverified');
  assert.equal(adapter.mayAutoRetry(request, result), false);
  assert.equal(computerActionMayAutoRetry(request, result), false);
});

test('browser computer adapter delegates ordinary activation through TaskRuntime', async () => {
  const runtime = new FakeBrowserRuntime();
  const adapter = new BrowserComputerEnvironmentAdapter(runtime, {
    runtimeOptions: { maxRisk: 'interaction' },
  });
  const target = adapter.entityForNode(runtime.nodes[0], adapter.currentSurface());
  const result = await adapter.act({
    ...localAction(adapter, 'browser.activate', target),
    payload: { method: 'pointer' },
  });
  assert.equal(runtime.activateCalls, 1);
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(result.verification, 'verified');
});

test('browser computer adapter cannot bypass commitment neutral-baseline verification', async () => {
  const runtime = new FakeBrowserRuntime();
  runtime.nodes = [node({ name: 'Pay now' })];
  runtime.documentText = 'Payment confirmed. Order complete.';
  const adapter = new BrowserComputerEnvironmentAdapter(runtime, {
    runtimeOptions: {
      maxRisk: 'external-side-effect',
      approve: async () => true,
      commitmentVerificationMaxPolls: 1,
      commitmentVerificationPollIntervalMs: 0,
    },
  });
  const target = adapter.entityForNode(runtime.nodes[0], adapter.currentSurface());
  const result = await adapter.act({
    adapterId: adapter.descriptor.id,
    actionId: 'synthetic-purchase',
    capability: 'browser.activate',
    effect: 'external-transaction',
    idempotency: 'non-idempotent',
    target,
  });
  assert.equal(runtime.activateCalls, 0);
  assert.equal(result.dispatch, 'not-dispatched');
  assert.notEqual(result.status, 'completed');
});

test('unknown dispatch is never retry eligible for side-effecting browser request', () => {
  const request: ComputerActionRequest = {
    adapterId: 'browser-chromium', actionId: 'x', capability: 'browser.activate',
    effect: 'external-transaction', idempotency: 'non-idempotent',
  };
  assert.equal(computerActionMayAutoRetry(request, { dispatch: 'unknown' }), false);
});
