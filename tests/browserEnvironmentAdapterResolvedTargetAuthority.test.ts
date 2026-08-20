import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoundedSemanticSnapshotLimits } from '../src/browser/boundedSemanticSnapshot.js';
import type { BrowserTargetState } from '../src/browser/targetController.js';
import {
  BrowserComputerEnvironmentAdapter,
  type BrowserComputerRuntime,
  type BrowserFrameDocumentTokenLimits,
} from '../src/computer/browserEnvironmentAdapter.js';
import type { ComputerEntityRef } from '../src/computer/environmentAdapter.js';
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
    name: 'Stable fixture',
    capabilities: ['activate'],
    interactionConfidence: 1,
  };
}

class ResolvedTargetRuntime implements BrowserComputerRuntime {
  readonly targets: BrowserTargetState[] = [
    { targetId: 'page-a', type: 'page', attached: true, sequence: 7 },
  ];
  nodes: InteractionNode[] = [node()];
  browserStateCalls = 0;
  gateBrowserStateCall: number | undefined;
  browserStateEntered: (() => void) | undefined;
  browserStateGate: Promise<void> | undefined;
  resolvedNode: InteractionNode | undefined;
  resolvedOverride: InteractionNode | undefined;
  hoverCalls = 0;
  hoverEntityIds: string[] = [];

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
    this.browserStateCalls += 1;
    if (this.browserStateCalls === this.gateBrowserStateCall) {
      this.browserStateEntered?.();
      if (this.browserStateGate) await this.browserStateGate;
    }
    return {
      url: 'https://example.test/',
      origin: 'https://example.test',
      title: 'fixture',
      readyState: 'complete' as const,
      historyLength: 1,
      timeOrigin: 1,
    };
  }
  async frameDocumentTokens(
    _targetId: string | undefined,
    _limits: BrowserFrameDocumentTokenLimits,
  ): Promise<Readonly<Record<string, string>>> {
    return { main: '1' };
  }
  async semanticSnapshot(
    _targetId: string | undefined,
    limits: BoundedSemanticSnapshotLimits,
  ) {
    return {
      nodes: this.nodes.slice(0, limits.maxItems).map((item) => ({ ...item, backendNodeId: undefined })),
      complete: this.nodes.length <= limits.maxItems,
      truncated: this.nodes.length > limits.maxItems,
    };
  }
  async resolveBoundedSemanticTarget(): Promise<InteractionNode | undefined> {
    const resolved = this.resolvedOverride ?? this.nodes[0];
    this.resolvedNode = resolved;
    return resolved;
  }
  async hoverBoundedSemantic(
    _targetId: string | undefined,
    entityId: string,
  ): Promise<{ status: string; target: InteractionNode | null }> {
    this.hoverCalls += 1;
    this.hoverEntityIds.push(entityId);
    return { status: 'verified', target: this.nodes[0] };
  }
  async refresh(): Promise<InteractionNode[]> {
    throw new Error('legacy refresh must not run');
  }
  async activate(): Promise<{ status: string; target: InteractionNode | null }> {
    throw new Error('legacy activate must not run');
  }
  async hover(): Promise<{ status: string; target: InteractionNode | null }> {
    throw new Error('legacy hover must not run');
  }
  async typeInto(): Promise<{ status: string; target: InteractionNode | null }> {
    throw new Error('legacy type must not run');
  }
}

async function observedTarget(adapter: BrowserComputerEnvironmentAdapter): Promise<ComputerEntityRef> {
  const observed = await adapter.observe({
    adapterId: adapter.descriptor.id,
    channel: 'semantic-ui',
    surface: adapter.currentSurface(),
    limits: { maxItems: 1, maxTextBytes: 64, maxDepth: 1 },
  });
  return (observed.data as Array<{ entity: ComputerEntityRef }>)[0].entity;
}

test('resolved action node identity is captured before post-resolve document revalidation awaits', async () => {
  const runtime = new ResolvedTargetRuntime();
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const target = await observedTarget(adapter);
  const expectedStructuralId = runtime.nodes[0].structuralId!;

  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve; });
  runtime.gateBrowserStateCall = 4;
  runtime.browserStateGate = gate;
  runtime.browserStateEntered = entered;

  const pending = adapter.act({
    adapterId: adapter.descriptor.id,
    actionId: 'resolved-node-snapshot',
    capability: 'browser.hover',
    effect: 'local-reversible',
    idempotency: 'idempotent',
    target,
  });
  await enteredPromise;

  const live = runtime.resolvedNode!;
  live.id = 'mutated-node';
  live.structuralId = 'mutated-node';
  live.frameId = 'mutated-frame';

  release();
  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(runtime.hoverCalls, 1);
  assert.deepEqual(runtime.hoverEntityIds, [expectedStructuralId]);
});

test('accessor-backed resolved action identity fails closed without invoking getters', async () => {
  const runtime = new ResolvedTargetRuntime();
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const target = await observedTarget(adapter);
  let idGetterCalls = 0;
  const exotic = { ...node() } as InteractionNode;
  Object.defineProperty(exotic, 'id', {
    enumerable: true,
    get() {
      idGetterCalls += 1;
      return 'main:button:nth-of-type(1)';
    },
  });
  runtime.resolvedOverride = exotic;

  const result = await adapter.act({
    adapterId: adapter.descriptor.id,
    actionId: 'resolved-node-accessor',
    capability: 'browser.hover',
    effect: 'local-reversible',
    idempotency: 'idempotent',
    target,
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(idGetterCalls, 0);
  assert.equal(runtime.hoverCalls, 0);
});
