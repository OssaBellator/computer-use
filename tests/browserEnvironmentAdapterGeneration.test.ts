import assert from 'node:assert/strict';
import test from 'node:test';
import type { BrowserTargetState } from '../src/browser/targetController.js';
import {
  BrowserComputerEnvironmentAdapter,
  type BrowserComputerRuntime,
} from '../src/computer/browserEnvironmentAdapter.js';
import type { ComputerActionRequest, ComputerEntityRef } from '../src/computer/environmentAdapter.js';
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
  async frameDocumentTokens(): Promise<Readonly<Record<string, string>>> {
    this.frameTokenReads += 1;
    if (this.frameTokenReads === this.frameTokenMutationRead) {
      const mutate = this.frameTokenMutation;
      this.frameTokenMutation = undefined;
      mutate?.();
    }
    return { ...this.frameTokens };
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