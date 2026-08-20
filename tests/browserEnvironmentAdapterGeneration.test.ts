import assert from 'node:assert/strict';
import test from 'node:test';
import type { BoundedSemanticSnapshotLimits } from '../src/browser/boundedSemanticSnapshot.js';
import type { BrowserTargetState } from '../src/browser/targetController.js';
import {
  BrowserComputerEnvironmentAdapter,
  type BrowserComputerEnvironmentAdapterOptions,
  type BrowserComputerRuntime,
  type BrowserFrameDocumentTokenLimits,
} from '../src/computer/browserEnvironmentAdapter.js';
import type { ComputerActionRequest, ComputerEntityRef } from '../src/computer/environmentAdapter.js';
import { CdpBrowserAgentEngine } from '../src/engine/cdpBrowserAgentEngine.js';
import type { InteractionNode } from '../src/types.js';

function node(frameId = 'main'): InteractionNode {
  return {
    id: 'backend:41',
    structuralId: `${frameId}:button:nth-of-type(1)`,
    backendNodeId: 41,
    frameId,
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
    editable: true,
    scrollable: false,
    role: 'button',
    name: 'Stable fixture',
    capabilities: ['activate', 'type'],
    interactionConfidence: 1,
  };
}

class GenerationRuntime implements BrowserComputerRuntime {
  targets: BrowserTargetState[] = [{ targetId: 'page-a', type: 'page', attached: true, sequence: 7 }];
  active = 'page-a';
  nodes: InteractionNode[] = [node()];
  timeOrigin = 1;
  frameTokens: Record<string, string> = { main: '1' };
  frameTokenLimits: BrowserFrameDocumentTokenLimits | undefined;
  refreshMutation: (() => void) | undefined;
  frameTokenReads = 0;
  frameTokenMutationRead: number | undefined;
  frameTokenMutation: (() => void) | undefined;
  activateCalls = 0;
  hoverCalls = 0;
  typeCalls = 0;

  browserTargets(): BrowserTargetState[] { return this.targets.map((target) => ({ ...target })); }
  activePageTargetId(): string | undefined { return this.active; }
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
      timeOrigin: this.timeOrigin,
    };
  }
  async frameDocumentTokens(
    _targetId?: string,
    limits?: BrowserFrameDocumentTokenLimits,
  ): Promise<Readonly<Record<string, string>>> {
    this.frameTokenLimits = limits;
    this.frameTokenReads += 1;
    if (this.frameTokenReads === this.frameTokenMutationRead) {
      const mutate = this.frameTokenMutation;
      this.frameTokenMutation = undefined;
      mutate?.();
    }
    return { ...this.frameTokens };
  }
  async semanticSnapshot(
    _targetId: string | undefined,
    limits: BoundedSemanticSnapshotLimits,
  ) {
    const mutate = this.refreshMutation;
    this.refreshMutation = undefined;
    mutate?.();
    const nodes = this.nodes.slice(0, limits.maxItems).map((item) => ({ ...item }));
    return { nodes, complete: this.nodes.length <= limits.maxItems, truncated: this.nodes.length > limits.maxItems };
  }
  async refresh(): Promise<InteractionNode[]> {
    const mutate = this.refreshMutation;
    this.refreshMutation = undefined;
    mutate?.();
    return this.nodes.map((item) => ({ ...item }));
  }
  async activate(): Promise<{ status: string; target: InteractionNode | null }> {
    this.activateCalls += 1;
    return { status: 'verified', target: this.nodes[0] ?? null };
  }
  async hover(): Promise<{ status: string; target: InteractionNode | null }> {
    this.hoverCalls += 1;
    return { status: 'verified', target: this.nodes[0] ?? null };
  }
  async typeInto(): Promise<{ status: string; target: InteractionNode | null }> {
    this.typeCalls += 1;
    return { status: 'verified', target: this.nodes[0] ?? null };
  }
}

async function observedTarget(adapter: BrowserComputerEnvironmentAdapter): Promise<ComputerEntityRef> {
  const observed = await adapter.observe({
    adapterId: adapter.descriptor.id,
    channel: 'semantic-ui',
    surface: adapter.currentSurface(),
  });
  return (observed.data as Array<{ entity: ComputerEntityRef }>)[0].entity;
}

function action(
  adapter: BrowserComputerEnvironmentAdapter,
  capability: string,
  target: ComputerEntityRef,
  payload?: unknown,
): ComputerActionRequest {
  return {
    adapterId: adapter.descriptor.id,
    actionId: 'generation-test',
    capability,
    effect: 'local-reversible',
    idempotency: 'idempotent',
    target,
    ...(payload !== undefined ? { payload } : {}),
  };
}

test('browser entity identity invalidates deterministically on child-frame document replacement', async () => {
  const runtime = new GenerationRuntime();
  runtime.nodes = [node('frame-1')];
  runtime.frameTokens = { main: '1', 'frame-1': 'child-a' };
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const target = await observedTarget(adapter);
  assert.match(target.entityId, /frame:frame-1:gen:child-a:backend:41$/);

  runtime.frameTokens['frame-1'] = 'child-b';
  const result = await adapter.act(action(adapter, 'browser.hover', target));
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(runtime.hoverCalls, 0);
  assert.equal(runtime.timeOrigin, 1);
  assert.equal(runtime.targets[0].sequence, 7);
});

test('semantic observation fails closed when document generation changes during refresh', async () => {
  const runtime = new GenerationRuntime();
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  runtime.refreshMutation = () => {
    runtime.timeOrigin = 2;
    runtime.frameTokens.main = '2';
  };

  await assert.rejects(
    adapter.observe({ adapterId: adapter.descriptor.id, channel: 'semantic-ui', surface: adapter.currentSurface() }),
    /identity-changed/,
  );
});

test('action does not dispatch when refresh returns same backend id from a replacement document', async () => {
  const runtime = new GenerationRuntime();
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const target = await observedTarget(adapter);
  runtime.refreshMutation = () => {
    runtime.timeOrigin = 2;
    runtime.frameTokens.main = '2';
    runtime.nodes = [node('main')];
  };

  const result = await adapter.act(action(adapter, 'browser.hover', target));
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(runtime.hoverCalls, 0);
});

test('activation remains definitely not-dispatched when child-frame identity changes at the TaskRuntime dispatch boundary', async () => {
  const runtime = new GenerationRuntime();
  runtime.nodes = [node('frame-1')];
  runtime.frameTokens = { main: '1', 'frame-1': 'child-a' };
  const adapter = new BrowserComputerEnvironmentAdapter(runtime, { runtimeOptions: { maxRisk: 'interaction' } });
  const target = await observedTarget(adapter);

  runtime.frameTokenReads = 0;
  runtime.frameTokenMutationRead = 3;
  runtime.frameTokenMutation = () => { runtime.frameTokens['frame-1'] = 'child-b'; };

  const result = await adapter.act(action(adapter, 'browser.activate', target, { method: 'pointer' }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(result.verification, 'not-applicable');
  assert.equal(runtime.activateCalls, 0);
});

test('validated action authority is immutable while entity resolution awaits', async () => {
  const runtime = new GenerationRuntime();
  const approvals: Array<{ programName: string; kind: string; risk: string }> = [];
  const adapter = new BrowserComputerEnvironmentAdapter(runtime, {
    runtimeOptions: {
      maxRisk: 'observe',
      approve: async (context) => {
        approvals.push({ programName: context.programName, kind: context.kind, risk: context.risk });
        return false;
      },
    },
  });
  const target = await observedTarget(adapter);
  const request: ComputerActionRequest = {
    adapterId: adapter.descriptor.id,
    actionId: 'authority-original',
    capability: 'browser.activate',
    effect: 'external-transaction',
    idempotency: 'non-idempotent',
    target: { ...target },
    payload: { method: 'keyboard', key: 'Enter' },
  };

  runtime.refreshMutation = () => {
    request.actionId = 'authority-mutated';
    request.capability = 'browser.press-key';
    request.effect = 'local-reversible';
    request.idempotency = 'idempotent';
    if (request.target) request.target.entityId = 'unbound:frame:main:backend:999';
  };

  const result = await adapter.act(request);
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.deepEqual(approvals, [{
    programName: 'computer-adapter:authority-original',
    kind: 'activate',
    risk: 'external-side-effect',
  }]);
  assert.equal(runtime.activateCalls, 0);
});

test('accessor-backed action authority is rejected before getters can drift effect or target', async () => {
  const runtime = new GenerationRuntime();
  let approvals = 0;
  let effectGetterCalls = 0;
  let targetGetterCalls = 0;
  const adapter = new BrowserComputerEnvironmentAdapter(runtime, {
    runtimeOptions: {
      maxRisk: 'observe',
      approve: async () => {
        approvals += 1;
        return true;
      },
    },
  });
  const target = await observedTarget(adapter);
  const request = {
    adapterId: adapter.descriptor.id,
    actionId: 'accessor-authority',
    capability: 'browser.activate',
    idempotency: 'non-idempotent',
    payload: { method: 'pointer' },
  } as Record<string, unknown>;
  Object.defineProperty(request, 'effect', {
    enumerable: true,
    get() {
      effectGetterCalls += 1;
      return effectGetterCalls === 1 ? 'external-transaction' : 'local-reversible';
    },
  });
  Object.defineProperty(request, 'target', {
    enumerable: true,
    get() {
      targetGetterCalls += 1;
      return targetGetterCalls === 1 ? target : undefined;
    },
  });

  const result = await adapter.act(request as unknown as ComputerActionRequest);
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(effectGetterCalls, 0);
  assert.equal(targetGetterCalls, 0);
  assert.equal(approvals, 0);
  assert.equal(runtime.activateCalls, 0);
});

test('accessor-backed action payload is rejected without invoking payload getters', async () => {
  const runtime = new GenerationRuntime();
  let methodGetterCalls = 0;
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const target = await observedTarget(adapter);
  const payload = Object.defineProperty({}, 'method', {
    enumerable: true,
    get() {
      methodGetterCalls += 1;
      return 'pointer';
    },
  });

  const result = await adapter.act({
    adapterId: adapter.descriptor.id,
    actionId: 'accessor-payload',
    capability: 'browser.activate',
    effect: 'local-reversible',
    idempotency: 'idempotent',
    target,
    payload,
  });
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(methodGetterCalls, 0);
  assert.equal(runtime.activateCalls, 0);
});

test('runtime approval policy is immutable after adapter construction', async () => {
  const runtime = new GenerationRuntime();
  const originalApprovals: string[] = [];
  let mutatedApprovals = 0;
  const runtimeOptions: NonNullable<BrowserComputerEnvironmentAdapterOptions['runtimeOptions']> = {
    maxRisk: 'observe',
    approve: async () => {
      originalApprovals.push('original');
      return false;
    },
  };
  const adapter = new BrowserComputerEnvironmentAdapter(runtime, { runtimeOptions });
  const target = await observedTarget(adapter);

  runtime.refreshMutation = () => {
    runtimeOptions.maxRisk = 'external-side-effect';
    runtimeOptions.approve = async () => {
      mutatedApprovals += 1;
      return true;
    };
  };

  const result = await adapter.act({
    adapterId: adapter.descriptor.id,
    actionId: 'policy-snapshot',
    capability: 'browser.activate',
    effect: 'external-transaction',
    idempotency: 'non-idempotent',
    target,
    payload: { method: 'pointer' },
  });

  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.deepEqual(originalApprovals, ['original']);
  assert.equal(mutatedApprovals, 0);
  assert.equal(runtime.activateCalls, 0);
  assert.equal(Object.isFrozen(adapter.options), true);
  assert.equal(Object.isFrozen(adapter.options.runtimeOptions), true);
  assert.equal(Object.isFrozen(adapter.descriptor), true);
  assert.equal(Object.isFrozen(adapter.descriptor.capabilities), true);
});

test('adapter rejects accessor-backed policy objects without invoking accessors', () => {
  const runtime = new GenerationRuntime();
  let getterCalls = 0;
  const runtimeOptions = Object.defineProperty({}, 'approve', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return async () => true;
    },
  });
  const options = { runtimeOptions } as BrowserComputerEnvironmentAdapterOptions;

  assert.throws(
    () => new BrowserComputerEnvironmentAdapter(runtime, options),
    /browser runtime options\.approve must be a data property/,
  );
  assert.equal(getterCalls, 0);
});

test('malformed maxRisk is rejected before high-risk browser dispatch can be configured', () => {
  const runtime = new GenerationRuntime();
  const options = {
    runtimeOptions: { maxRisk: 'bogus' },
  } as unknown as BrowserComputerEnvironmentAdapterOptions;

  assert.throws(
    () => new BrowserComputerEnvironmentAdapter(runtime, options),
    /browser runtime options\.maxRisk is invalid/,
  );
  assert.equal(runtime.activateCalls, 0);
});

test('malformed runtime policy shapes fail closed at construction', () => {
  const malformed: Array<Record<string, unknown>> = [
    { requireUnambiguousTargets: 'yes' },
    { maxConsecutiveNoProgress: 0 },
    { commitmentVerificationMaxPolls: Number.NaN },
    { commitmentVerificationPollIntervalMs: -1 },
    { approve: true },
    { onCommitmentVerification: {} },
    { onTrace: 'trace' },
    { waitPollIntervalMs: 1.5 },
    { waitMaxPolls: 0 },
  ];

  for (const runtimeOptions of malformed) {
    const runtime = new GenerationRuntime();
    const options = { runtimeOptions } as unknown as BrowserComputerEnvironmentAdapterOptions;
    assert.throws(() => new BrowserComputerEnvironmentAdapter(runtime, options), /browser runtime options\./);
    assert.equal(runtime.activateCalls, 0);
  }
});

test('runtime polling policy has adapter-owned hard ceilings', () => {
  const oversized: Array<Record<string, unknown>> = [
    { maxConsecutiveNoProgress: 17 },
    { commitmentVerificationMaxPolls: 33 },
    { waitMaxPolls: 33 },
    { commitmentVerificationPollIntervalMs: 5_001 },
    { waitPollIntervalMs: 5_001 },
    { commitmentVerificationMaxPolls: Number.MAX_SAFE_INTEGER },
    { waitPollIntervalMs: Number.MAX_SAFE_INTEGER },
  ];

  for (const runtimeOptions of oversized) {
    const runtime = new GenerationRuntime();
    const options = { runtimeOptions } as unknown as BrowserComputerEnvironmentAdapterOptions;
    assert.throws(() => new BrowserComputerEnvironmentAdapter(runtime, options), /browser runtime options\./);
    assert.equal(runtime.activateCalls, 0);
  }
});

test('ordinary bounded runtime polling policy remains accepted', () => {
  const runtime = new GenerationRuntime();
  const adapter = new BrowserComputerEnvironmentAdapter(runtime, {
    runtimeOptions: {
      maxConsecutiveNoProgress: 16,
      commitmentVerificationMaxPolls: 32,
      commitmentVerificationPollIntervalMs: 5_000,
      waitMaxPolls: 32,
      waitPollIntervalMs: 5_000,
    },
  });

  assert.deepEqual(adapter.options.runtimeOptions, {
    maxConsecutiveNoProgress: 16,
    commitmentVerificationMaxPolls: 32,
    commitmentVerificationPollIntervalMs: 5_000,
    waitPollIntervalMs: 5_000,
    waitMaxPolls: 32,
  });
});

test('bounded frame identity source never materializes the unbounded frame list', async () => {
  let evaluations = 0;
  let boundedCalls = 0;
  let fullFramesCalls = 0;
  let requestedMaxFrames = 0;
  const mainFrame = {
    evaluate: async () => {
      evaluations += 1;
      return 1;
    },
  };
  const page = {
    frames: () => {
      fullFramesCalls += 1;
      throw new Error('unbounded frame materialization must not be used for identity');
    },
    boundedFrames: (maxFrames: number) => {
      boundedCalls += 1;
      requestedMaxFrames = maxFrames;
      return { frames: [mainFrame], complete: false };
    },
  };
  const engine = new CdpBrowserAgentEngine(
    {} as any,
    {} as any,
    {} as any,
    undefined,
    undefined,
    undefined,
    {} as any,
    undefined,
    undefined,
    undefined,
    {} as any,
    undefined,
    page as any,
  );

  const tokens = await engine.frameDocumentTokens({ maxFrames: 32, maxTextBytes: 4 * 1024 });
  assert.equal(fullFramesCalls, 0);
  assert.equal(boundedCalls, 1);
  assert.equal(requestedMaxFrames, 32);
  assert.equal(evaluations, 1);
  assert.equal(tokens?.main, '1');
  assert.equal(tokens?.['frame-1'], undefined);
  assert.equal(tokens?.['__browser_identity_incomplete__'], '1');
  assert.deepEqual(Object.keys(tokens ?? {}).sort(), ['__browser_identity_incomplete__', 'main']);
});

test('adapter pushes frame identity limits to custom runtimes and rejects incomplete child authority', async () => {
  const runtime = new GenerationRuntime();
  runtime.nodes = [node('frame-1')];
  runtime.frameTokens = {
    main: '1',
    'frame-1': 'child-a',
    __browser_identity_incomplete__: '1',
  };
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);

  await assert.rejects(
    adapter.observe({ adapterId: adapter.descriptor.id, channel: 'semantic-ui', surface: adapter.currentSurface() }),
    /identity-unavailable/,
  );
  assert.deepEqual(runtime.frameTokenLimits, { maxFrames: 32, maxTextBytes: 4 * 1024 });
  assert.equal(runtime.activateCalls, 0);
  assert.equal(runtime.hoverCalls, 0);
});

test('typing rejects an aggregate per-character delay above the hard duration budget', async () => {
  const runtime = new GenerationRuntime();
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);
  const target = await observedTarget(adapter);
  const result = await adapter.act(action(adapter, 'browser.type', target, {
    text: 'x'.repeat(31),
    delayMs: 1_000,
  }));
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(runtime.typeCalls, 0);
});
