import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoundedSemanticSnapshotLimits } from '../src/browser/boundedSemanticSnapshot.js';
import type { BrowserTargetState } from '../src/browser/targetController.js';
import {
  BrowserComputerEnvironmentAdapter,
  type BrowserComputerRuntime,
} from '../src/computer/browserEnvironmentAdapter.js';
import type {
  ComputerActionRequest,
  ComputerEntityRef,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import type { InteractionNode } from '../src/types.js';

function node(): InteractionNode {
  return {
    id: 'main:button:nth-of-type(1)',
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
    name: 'abcdefghij',
    capabilities: ['activate'],
    interactionConfidence: 1,
  };
}

class ObservationRuntime implements BrowserComputerRuntime {
  readonly targets: BrowserTargetState[] = [
    { targetId: 'page-a', type: 'page', attached: true, sequence: 7 },
  ];
  nodes: InteractionNode[] = [node()];
  semanticOptions: BoundedSemanticSnapshotLimits | undefined;
  semanticCalls = 0;
  visualCalls = 0;
  scrollCalls = 0;
  semanticEntered: (() => void) | undefined;
  semanticGate: Promise<void> | undefined;

  browserTargets(): BrowserTargetState[] { return this.targets.map((target) => ({ ...target })); }
  activePageTargetId(): string { return 'page-a'; }
  targetState() {
    return {
      total: 1,
      pages: 1,
      unattachedPages: 0,
      latestPage: this.targets[0],
      latestUnattachedPage: undefined,
    };
  }
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
  async semanticSnapshot(_targetId: string | undefined, limits: BoundedSemanticSnapshotLimits) {
    this.semanticCalls += 1;
    this.semanticOptions = { ...limits };
    this.semanticEntered?.();
    if (this.semanticGate) await this.semanticGate;
    return {
      nodes: this.nodes.slice(0, limits.maxItems).map((item) => ({ ...item, backendNodeId: undefined })),
      complete: this.nodes.length <= limits.maxItems,
      truncated: this.nodes.length > limits.maxItems,
    };
  }
  async visualSnapshot(): Promise<any> {
    this.visualCalls += 1;
    return {
      format: 'png', mimeType: 'image/png', dataBase64: 'AA==', byteLength: 1,
      sha256: '0'.repeat(64), width: 1, height: 1,
    };
  }
  async refresh(): Promise<InteractionNode[]> { return this.nodes.map((item) => ({ ...item })); }
  async activate(): Promise<any> { return { status: 'target-not-found', target: null }; }
  async hover(): Promise<any> { return { status: 'target-not-found', target: null }; }
  async typeInto(): Promise<any> { return { status: 'target-not-found', target: null }; }
  async pressKey(): Promise<any> { return { status: 'unverified' }; }
  async scrollViewport(): Promise<any> {
    this.scrollCalls += 1;
    return { status: 'verified' };
  }
}

async function observedTarget(adapter: BrowserComputerEnvironmentAdapter): Promise<ComputerEntityRef> {
  const observed = await adapter.observe({
    adapterId: adapter.descriptor.id,
    channel: 'semantic-ui',
    surface: adapter.currentSurface(),
    limits: { maxItems: 1, maxTextBytes: 64, maxDepth: 2 },
  });
  return (observed.data as Array<{ entity: ComputerEntityRef }>)[0].entity;
}

function noOwnKeys<T extends object>(value: T, onOwnKeys: () => void): T {
  return new Proxy(value, {
    ownKeys() {
      onOwnKeys();
      throw new Error('bulk own-key enumeration must not run');
    },
  });
}

test('browser observation authority stays immutable while bounded acquisition awaits', async () => {
  const runtime = new ObservationRuntime();
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const target = await observedTarget(adapter);
  const originalTarget = { ...target };

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  runtime.semanticGate = gate;
  runtime.semanticEntered = entered;

  const request: ComputerObservationRequest = {
    adapterId: adapter.descriptor.id,
    channel: 'semantic-ui',
    target: { ...target },
    limits: { maxItems: 1, maxTextBytes: 5, maxDepth: 1 },
  };
  const pending = adapter.observe(request);
  await enteredPromise;

  request.channel = 'visual';
  request.limits!.maxItems = 1_000_000_000;
  request.limits!.maxTextBytes = 1_000_000_000;
  request.limits!.maxDepth = 1_000_000_000;
  request.target!.entityId = 'mutated-target';
  request.target = undefined;

  release();
  const observed = await pending;

  assert.equal(observed.channel, 'semantic-ui');
  assert.deepEqual(observed.target, originalTarget);
  assert.deepEqual(runtime.semanticOptions, { maxItems: 1, maxTextBytes: 5, maxDepth: 1 });
  assert.equal(runtime.visualCalls, 0);
  assert.equal((observed.data as Array<{ name?: string }>)[0].name, 'abcde');
});

test('accessor-backed browser observation envelopes fail closed without invoking getters', async () => {
  const runtime = new ObservationRuntime();
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  let channelGetterCalls = 0;
  const request = {
    adapterId: adapter.descriptor.id,
    limits: { maxItems: 1 },
  } as Record<string, unknown>;
  Object.defineProperty(request, 'channel', {
    enumerable: true,
    get() {
      channelGetterCalls += 1;
      return 'semantic-ui';
    },
  });

  await assert.rejects(
    adapter.observe(request as unknown as ComputerObservationRequest),
    /invalid-envelope/,
  );
  assert.equal(channelGetterCalls, 0);
  assert.equal(runtime.semanticCalls, 0);
});

test('browser envelope snapshots never enumerate arbitrary caller own keys', async () => {
  const runtime = new ObservationRuntime();
  let ownKeysCalls = 0;
  const trap = () => { ownKeysCalls += 1; };

  const runtimeOptions = noOwnKeys({ maxRisk: 'interaction' as const }, trap);
  const options = noOwnKeys({ runtimeOptions }, trap);
  const adapter = new BrowserComputerEnvironmentAdapter(runtime, options);
  const target = await observedTarget(adapter);

  const hugeLimits: Record<string, unknown> = { maxItems: 1, maxTextBytes: 5, maxDepth: 1 };
  for (let index = 0; index < 10_000; index += 1) hugeLimits[`ignored-${index}`] = index;
  const proxiedLimits = noOwnKeys(hugeLimits, trap);
  const proxiedTarget = noOwnKeys({ ...target, ignored: 'extra' }, trap);
  const observation = noOwnKeys({
    adapterId: adapter.descriptor.id,
    channel: 'semantic-ui' as const,
    target: proxiedTarget,
    limits: proxiedLimits,
    ignored: 'extra',
  }, trap);

  const observed = await adapter.observe(observation as ComputerObservationRequest);
  assert.equal(observed.channel, 'semantic-ui');
  assert.deepEqual(runtime.semanticOptions, { maxItems: 1, maxTextBytes: 5, maxDepth: 1 });
  assert.equal((observed.data as Array<{ name?: string }>)[0].name, 'abcde');

  const payload = noOwnKeys({ deltaY: 1, ignored: 'extra' }, trap);
  const action = noOwnKeys({
    adapterId: adapter.descriptor.id,
    actionId: 'bounded-descriptors',
    capability: 'browser.scroll-viewport',
    effect: 'local-reversible' as const,
    idempotency: 'idempotent' as const,
    payload,
    ignored: 'extra',
  }, trap);
  const result = await adapter.act(action as ComputerActionRequest);
  assert.equal(result.status, 'completed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(runtime.scrollCalls, 1);
  assert.equal(adapter.options.runtimeOptions?.maxRisk, 'interaction');
  assert.equal(ownKeysCalls, 0);
});
