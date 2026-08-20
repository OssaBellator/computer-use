import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserTargetState } from '../src/browser/targetController.js';
import {
  BrowserComputerEnvironmentAdapter,
  type BrowserComputerRuntime,
} from '../src/computer/browserEnvironmentAdapter.js';
import { computerActionMayAutoRetry, type ComputerActionRequest, type ComputerEntityRef } from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { InteractionNode } from '../src/types.js';

function node(overrides: Partial<InteractionNode> = {}): InteractionNode {
  return {
    id: 'backend:41', structuralId: 'main:button:nth-of-type(1)', backendNodeId: 41, frameId: 'main',
    focused: false, disabled: false,
    rect: { x: 1, y: 1, width: 20, height: 10 }, visibleRect: { x: 1, y: 1, width: 20, height: 10 }, viewportVisible: true,
    mainViewportRect: { x: 1, y: 1, width: 20, height: 10 }, mainViewportVisibleRect: { x: 1, y: 1, width: 20, height: 10 }, mainViewportVisible: true,
    focusable: true, clickable: true, editable: false, scrollable: false,
    role: 'button', name: 'Safe action', capabilities: ['activate'], interactionConfidence: 1,
    ...overrides,
  };
}

class FakeBrowserRuntime implements BrowserComputerRuntime {
  targets: BrowserTargetState[] = [{ targetId: 'page-a', type: 'page', attached: true, sequence: 7 }];
  active = 'page-a';
  nodes: InteractionNode[] = [node()];
  documentText = 'Synthetic fixture content';
  timeOrigin = 1;
  activationResult = 'verified';
  throwOnType = false;
  activateCalls = 0;
  hoverCalls = 0;
  typeCalls = 0;
  scrollCalls = 0;
  documentOptions: { maxBlocks?: number; maxTextBytes?: number; maxDepth?: number } | undefined;
  visualOptions: { maxBytes?: number } | undefined;
  mediaOptions: { maxMediaElements?: number; maxFrames?: number; maxTextLength?: number } | undefined;

  browserTargets(): BrowserTargetState[] { return this.targets.map((target) => ({ ...target })); }
  activePageTargetId(): string | undefined { return this.active; }
  targetState() {
    const pages = this.targets.filter((target) => target.type === 'page');
    const unattached = pages.filter((target) => !target.attached);
    return { total: this.targets.length, pages: pages.length, unattachedPages: unattached.length, latestPage: pages.at(-1), latestUnattachedPage: unattached.at(-1) };
  }
  async refresh(): Promise<InteractionNode[]> { return this.nodes.map((item) => ({ ...item })); }
  async activate(): Promise<{ status: string; target: InteractionNode | null }> { this.activateCalls += 1; return { status: this.activationResult, target: this.nodes[0] ?? null }; }
  async hover(): Promise<{ status: string; target: InteractionNode | null }> { this.hoverCalls += 1; return { status: 'verified', target: this.nodes[0] ?? null }; }
  async typeInto(): Promise<{ status: string; target: InteractionNode | null }> { this.typeCalls += 1; if (this.throwOnType) throw new Error('transport failed after invocation'); return { status: 'verified', target: this.nodes[0] ?? null }; }
  async pressKey(): Promise<{ status: string }> { return { status: 'verified' }; }
  async scrollViewport(): Promise<{ status: string }> { this.scrollCalls += 1; return { status: 'verified' }; }
  async browserState() { return { url: 'https://example.test/', origin: 'https://example.test', title: 'fixture', readyState: 'complete' as const, historyLength: 1, timeOrigin: this.timeOrigin }; }
  async documentContent(options?: { maxBlocks?: number; maxTextBytes?: number; maxDepth?: number }) {
    this.documentOptions = options;
    const text = this.documentText;
    return {
      frames: [{ frameId: 'main', title: 'fixture', includedBlocks: 1, browserExtractionTruncated: false }],
      blocks: [{ id: 'main:p:1', frameId: 'main', kind: 'paragraph' as const, tagName: 'p', depth: 1, text, rendered: true, inViewport: true, truncated: false }],
      totalTextBytes: Buffer.byteLength(text), truncated: false, frameErrors: [],
    };
  }
  async documentContentForPage(_targetId: string, options?: { maxBlocks?: number; maxTextBytes?: number; maxDepth?: number }) { return this.documentContent(options); }
  async visualSnapshot(_targetId: string | undefined, options?: { maxBytes?: number }): Promise<any> {
    this.visualOptions = options;
    return { format: 'png', mimeType: 'image/png', dataBase64: 'AA==', byteLength: 1, sha256: '0'.repeat(64), width: 1, height: 1 };
  }
  async mediaSnapshot(_targetId: string | undefined, options?: { maxMediaElements?: number; maxFrames?: number; maxTextLength?: number }): Promise<any> {
    this.mediaOptions = options;
    return { media: [], activeMediaCount: 0, fullscreen: { pageState: 'inactive', browserWindowState: 'not-fullscreen' }, truncated: false, errors: [] };
  }
}

async function observedTarget(adapter: BrowserComputerEnvironmentAdapter): Promise<ComputerEntityRef> {
  const observed = await adapter.observe({ adapterId: adapter.descriptor.id, channel: 'semantic-ui', surface: adapter.currentSurface(), limits: { maxItems: 5, maxTextBytes: 256 } });
  return (observed.data as Array<{ entity: ComputerEntityRef }>)[0].entity;
}
function localAction(adapter: BrowserComputerEnvironmentAdapter, capability: string, target?: ComputerEntityRef): ComputerActionRequest {
  return { adapterId: adapter.descriptor.id, actionId: 'test-action', capability, effect: 'local-reversible', idempotency: 'idempotent', ...(target ? { target } : {}) };
}

test('browser computer adapter preserves stable surface and document-bound target identity', async () => {
  const runtime = new FakeBrowserRuntime(), adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const first = adapter.currentSurface(), second = adapter.currentSurface();
  assert.deepEqual(first, second); assert.equal(first?.surfaceId, 'page-a'); assert.equal(first?.generation, 7);
  const target = await observedTarget(adapter);
  assert.match(target.entityId, /^doc:[^:]+:frame:main:backend:41$/); assert.equal(target.surfaceId, 'page-a'); assert.equal(target.generation, 7);
});

test('browser computer adapter rejects stale surface generation and document replacement before dispatch', async () => {
  const runtime = new FakeBrowserRuntime(), adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const surface = adapter.currentSurface()!, entity = await observedTarget(adapter);
  runtime.targets = [{ targetId: 'page-a', type: 'page', attached: true, sequence: 8 }];
  await assert.rejects(adapter.observe({ adapterId: adapter.descriptor.id, channel: 'semantic-ui', surface }), /generation-mismatch/);
  assert.equal((await adapter.act(localAction(adapter, 'browser.hover', entity))).dispatch, 'not-dispatched');
  runtime.targets = [{ targetId: 'page-a', type: 'page', attached: true, sequence: 7 }]; runtime.timeOrigin = 2;
  assert.equal((await adapter.act(localAction(adapter, 'browser.hover', entity))).dispatch, 'not-dispatched'); assert.equal(runtime.hoverCalls, 0);
});

test('browser computer adapter rejects generationless browser UI entities', async () => {
  const runtime = new FakeBrowserRuntime(), adapter = new BrowserComputerEnvironmentAdapter(runtime), target = await observedTarget(adapter);
  const result = await adapter.act(localAction(adapter, 'browser.hover', { ...target, generation: undefined }));
  assert.equal(result.status, 'rejected'); assert.equal(result.dispatch, 'not-dispatched'); assert.equal(runtime.hoverCalls, 0);
});

test('browser computer adapter preserves non-latest target identity from the full target list', () => {
  const runtime = new FakeBrowserRuntime();
  runtime.targets = [{ targetId: 'page-a', type: 'page', attached: true, sequence: 7 }, { targetId: 'page-b', type: 'page', attached: false, sequence: 8 }]; runtime.active = 'page-a';
  const surface = new BrowserComputerEnvironmentAdapter(runtime).currentSurface();
  assert.equal(surface?.surfaceId, 'page-a'); assert.equal(surface?.generation, 7);
});

test('browser computer adapter bounds semantic observations and reports truncation', async () => {
  const runtime = new FakeBrowserRuntime(); runtime.nodes = [node({ backendNodeId: 1, id: 'backend:1', name: 'abcdefghij' }), node({ backendNodeId: 2, id: 'backend:2', name: 'klmnopqrst' })];
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const observed = await adapter.observe({ adapterId: adapter.descriptor.id, channel: 'semantic-ui', surface: adapter.currentSurface(), limits: { maxItems: 1, maxTextBytes: 5 } });
  assert.equal((observed.data as Array<{ name?: string }>)[0].name, 'abcde'); assert.equal(observed.truncated, true); assert.equal(observed.complete, false);
});

test('browser computer adapter applies hard observation ceilings before backend calls', async () => {
  const runtime = new FakeBrowserRuntime(), adapter = new BrowserComputerEnvironmentAdapter(runtime), huge = 1_000_000_000;
  await adapter.observe({ adapterId: adapter.descriptor.id, channel: 'document', surface: adapter.currentSurface(), limits: { maxItems: huge, maxTextBytes: huge, maxDepth: huge } });
  assert.deepEqual(runtime.documentOptions, { maxBlocks: 256, maxTextBytes: 64 * 1024, maxDepth: 32 });
  await adapter.observe({ adapterId: adapter.descriptor.id, channel: 'visual', surface: adapter.currentSurface(), limits: { maxTextBytes: huge } });
  assert.deepEqual(runtime.visualOptions, { maxBytes: 2 * 1024 * 1024 });
  await adapter.observe({ adapterId: adapter.descriptor.id, channel: 'media', surface: adapter.currentSurface(), limits: { maxItems: huge, maxTextBytes: huge, maxDepth: huge } });
  assert.deepEqual(runtime.mediaOptions, { maxMediaElements: 64, maxFrames: 32, maxTextLength: 2048 });
});

test('browser computer adapter supports exact targeted semantic observation and rejects unsupported targeted channels before backend work', async () => {
  const runtime = new FakeBrowserRuntime(), adapter = new BrowserComputerEnvironmentAdapter(runtime), target = await observedTarget(adapter);
  const observed = await adapter.observe({ adapterId: adapter.descriptor.id, channel: 'semantic-ui', target });
  assert.deepEqual(observed.target, target); assert.equal((observed.data as unknown[]).length, 1);
  runtime.documentOptions = undefined;
  await assert.rejects(adapter.observe({ adapterId: adapter.descriptor.id, channel: 'document', target }), /target-unsupported/);
  assert.equal(runtime.documentOptions, undefined);
});

test('browser computer adapter supports verified read-only no-op semantics', async () => {
  const adapter = new BrowserComputerEnvironmentAdapter(new FakeBrowserRuntime());
  assert.deepEqual(await adapter.act({ adapterId: adapter.descriptor.id, actionId: 'observe-noop', capability: 'browser.semantic-ui.observe', effect: 'observe-only', idempotency: 'read-only' }), {
    status: 'completed', dispatch: 'not-dispatched', verification: 'verified', evidence: ['browser.verified-noop'],
  });
});

test('browser computer adapter reports definite pre-dispatch failure for disappeared target', async () => {
  const runtime = new FakeBrowserRuntime(), adapter = new BrowserComputerEnvironmentAdapter(runtime), target = await observedTarget(adapter); runtime.nodes = [];
  const result = await adapter.act(localAction(adapter, 'browser.hover', target));
  assert.equal(result.status, 'rejected'); assert.equal(result.dispatch, 'not-dispatched'); assert.equal(result.verification, 'not-applicable');
});

test('browser computer adapter rejects malformed and oversized action payloads before dispatch', async () => {
  const runtime = new FakeBrowserRuntime(), adapter = new BrowserComputerEnvironmentAdapter(runtime), target = await observedTarget(adapter);
  const cases: ComputerActionRequest[] = [
    { ...localAction(adapter, 'browser.type', target), payload: { text: 'x'.repeat(64 * 1024 + 1) } },
    { ...localAction(adapter, 'browser.type', target), payload: { text: 'x', expectedValue: 'x'.repeat(64 * 1024 + 1) } },
    { ...localAction(adapter, 'browser.type', target), payload: { text: 'x', delayMs: 1001 } },
    { ...localAction(adapter, 'browser.activate', target), payload: { method: 'synthetic' } },
    { ...localAction(adapter, 'browser.press-key'), payload: { key: 'x'.repeat(65) } },
    { ...localAction(adapter, 'browser.scroll-viewport'), payload: { deltaY: 100_001 } },
  ];
  for (const request of cases) assert.equal((await adapter.act(request)).dispatch, 'not-dispatched');
  assert.equal(runtime.activateCalls, 0); assert.equal(runtime.typeCalls, 0); assert.equal(runtime.scrollCalls, 0);
});

test('browser computer adapter rejects high-risk effects on direct input paths', async () => {
  const runtime = new FakeBrowserRuntime(), adapter = new BrowserComputerEnvironmentAdapter(runtime), target = await observedTarget(adapter);
  const requests: ComputerActionRequest[] = [
    { ...localAction(adapter, 'browser.hover', target), effect: 'external-transaction' },
    { ...localAction(adapter, 'browser.type', target), effect: 'security-sensitive', payload: { text: 'x' } },
    { ...localAction(adapter, 'browser.scroll-viewport'), effect: 'external-communication', payload: { deltaY: 1 } },
  ];
  for (const request of requests) { const result = await adapter.act(request); assert.equal(result.status, 'rejected'); assert.equal(result.dispatch, 'not-dispatched'); }
  assert.equal(runtime.hoverCalls, 0); assert.equal(runtime.typeCalls, 0); assert.equal(runtime.scrollCalls, 0);
});

test('browser computer adapter converts adapter exception after invocation into unknown dispatch and blocks retry', async () => {
  const runtime = new FakeBrowserRuntime(); runtime.throwOnType = true;
  const adapter = new BrowserComputerEnvironmentAdapter(runtime), target = await observedTarget(adapter);
  const request = { ...localAction(adapter, 'browser.type', target), payload: { text: 'synthetic' } };
  const result = await adapter.act(request);
  assert.equal(result.status, 'unknown'); assert.equal(result.dispatch, 'unknown'); assert.equal(result.verification, 'unverified');
  assert.equal(adapter.mayAutoRetry(request, result), false); assert.equal(computerActionMayAutoRetry(request, result), false);
});

test('browser computer adapter delegates ordinary activation through TaskRuntime', async () => {
  const runtime = new FakeBrowserRuntime(), adapter = new BrowserComputerEnvironmentAdapter(runtime, { runtimeOptions: { maxRisk: 'interaction' } }), target = await observedTarget(adapter);
  const result = await adapter.act({ ...localAction(adapter, 'browser.activate', target), payload: { method: 'pointer' } });
  assert.equal(runtime.activateCalls, 1); assert.equal(result.dispatch, 'dispatched-once'); assert.equal(result.verification, 'verified');
});

test('browser computer adapter cannot bypass commitment neutral-baseline verification', async () => {
  const runtime = new FakeBrowserRuntime(); runtime.nodes = [node({ name: 'Pay now' })]; runtime.documentText = 'Payment confirmed. Order complete.';
  const adapter = new BrowserComputerEnvironmentAdapter(runtime, { runtimeOptions: { maxRisk: 'external-side-effect', approve: async () => true, commitmentVerificationMaxPolls: 1, commitmentVerificationPollIntervalMs: 0 } });
  const target = await observedTarget(adapter);
  const result = await adapter.act({ adapterId: adapter.descriptor.id, actionId: 'synthetic-purchase', capability: 'browser.activate', effect: 'external-transaction', idempotency: 'non-idempotent', target });
  assert.equal(runtime.activateCalls, 0); assert.equal(result.dispatch, 'not-dispatched'); assert.notEqual(result.status, 'completed');
});

test('computer environment registry integrates browser routing and response coherence', async () => {
  const runtime = new FakeBrowserRuntime(), adapter = new BrowserComputerEnvironmentAdapter(runtime), registry = new ComputerEnvironmentRegistry(); registry.register(adapter);
  assert.ok(registry.descriptor(adapter.descriptor.id)?.capabilities.includes('browser.semantic-ui.observe'));
  const initial = await registry.observe({ adapterId: adapter.descriptor.id, channel: 'semantic-ui', surface: adapter.currentSurface() });
  const target = (initial.data as Array<{ entity: ComputerEntityRef }>)[0].entity;
  const targeted = await registry.observe({ adapterId: adapter.descriptor.id, channel: 'semantic-ui', target });
  assert.deepEqual(targeted.target, target); assert.deepEqual(targeted.surface, adapter.currentSurface());
  assert.equal((await registry.act(localAction(adapter, 'browser.hover', { ...target, generation: undefined }))).dispatch, 'not-dispatched');
  runtime.timeOrigin = 2; assert.equal((await registry.act(localAction(adapter, 'browser.hover', target))).dispatch, 'not-dispatched');
  const freshObservation = await registry.observe({ adapterId: adapter.descriptor.id, channel: 'semantic-ui', surface: adapter.currentSurface() });
  const fresh = (freshObservation.data as Array<{ entity: ComputerEntityRef }>)[0].entity;
  const result = await registry.act({ ...localAction(adapter, 'browser.type', fresh), payload: { text: 'x' } });
  assert.deepEqual({ status: result.status, dispatch: result.dispatch, verification: result.verification }, { status: 'completed', dispatch: 'dispatched-once', verification: 'verified' });
});

test('unknown dispatch is never retry eligible for side-effecting browser request', () => {
  const request: ComputerActionRequest = { adapterId: 'browser-chromium', actionId: 'x', capability: 'browser.activate', effect: 'external-transaction', idempotency: 'non-idempotent' };
  assert.equal(computerActionMayAutoRetry(request, { dispatch: 'unknown' }), false);
});
