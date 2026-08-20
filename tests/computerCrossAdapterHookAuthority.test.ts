import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEntityRef,
  ComputerEnvironmentAdapter,
  ComputerEnvironmentKind,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

class HookAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  actions = 0;
  observations = 0;

  constructor(
    id: string,
    kind: ComputerEnvironmentKind,
    capabilities: readonly string[],
    private readonly beforeObserve?: () => Promise<void>,
  ) {
    this.descriptor = Object.freeze({ id, kind, version: 'hook-authority-1', capabilities: Object.freeze([...capabilities]) });
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    this.observations += 1;
    if (this.beforeObserve) await this.beforeObserve();
    return {
      adapterId: this.descriptor.id,
      environment: this.descriptor.kind,
      channel: request.channel,
      sequence: this.observations,
      complete: true,
      truncated: false,
      target: request.target,
      data: null,
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actions += 1;
    return {
      status: 'completed',
      dispatch: 'dispatched-once',
      verification: 'verified',
      evidence: ['hook-adapter-ok'],
    };
  }
}

function registry(...adapters: ComputerEnvironmentAdapter[]): ComputerEnvironmentRegistry {
  const value = new ComputerEnvironmentRegistry();
  for (const adapter of adapters) value.register(adapter);
  return value;
}

test('approval and verifier authority are snapshotted before an earlier adapter await', async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observing = new Promise<void>((resolve) => { entered = resolve; });

  const browser = new HookAdapter('browser:hook-gate', 'browser', ['browser.observe'], async () => {
    entered();
    await gate;
  });
  const terminal = new HookAdapter('terminal:hook-action', 'terminal', ['fixture.execute']);
  const program: ComputerTaskProgram = {
    id: 'hook-authority-approval-verifier',
    entry: 'observe',
    steps: [
      {
        kind: 'observe',
        id: 'observe',
        request: { adapterId: browser.descriptor.id, channel: 'semantic-ui' },
        next: 'execute',
      },
      {
        kind: 'action',
        id: 'execute',
        request: {
          adapterId: terminal.descriptor.id,
          actionId: 'execute',
          capability: 'fixture.execute',
          effect: 'process-execution',
          idempotency: 'non-idempotent',
        },
        verification: 'fixture.verify',
      },
    ],
  };

  const hooks: any = {
    approve: async () => true,
    verifiers: {
      'fixture.verify': async () => ({ state: 'verified', evidence: ['original-verifier'] }),
    },
  };
  const runtime = new ComputerTaskRuntime(program, registry(browser, terminal), {
    executionId: EXECUTION_ID,
    hooks,
  });
  const pending = runtime.run();
  await observing;

  hooks.approve = async () => false;
  hooks.verifiers['fixture.verify'] = async () => ({ state: 'mismatch', evidence: ['mutated-verifier'] });
  release();

  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(terminal.actions, 1);
  assert.ok(result.evidence?.includes('original-verifier'));
  assert.equal(result.evidence?.includes('mutated-verifier'), false);
});

test('target revalidation authority cannot be replaced while approval is awaited', async () => {
  let approvalEntered!: () => void;
  let releaseApproval!: () => void;
  const entered = new Promise<void>((resolve) => { approvalEntered = resolve; });
  const approvalGate = new Promise<void>((resolve) => { releaseApproval = resolve; });

  const desktop = new HookAdapter('desktop:hook-target', 'desktop-ui', ['desktop.activate']);
  const entity: ComputerEntityRef = {
    adapterId: desktop.descriptor.id,
    environment: 'desktop-ui',
    kind: 'ui-control',
    entityId: 'control:stable',
    surfaceId: 'window:stable',
    generation: 1,
  };
  const program: ComputerTaskProgram = {
    id: 'hook-authority-revalidation',
    entry: 'activate',
    steps: [{
      kind: 'action',
      id: 'activate',
      request: {
        adapterId: desktop.descriptor.id,
        actionId: 'activate',
        capability: 'desktop.activate',
        effect: 'local-reversible',
        idempotency: 'idempotent',
        target: entity,
      },
      target: { entity },
    }],
  };

  let originalRevalidations = 0;
  let mutatedRevalidations = 0;
  const hooks: any = {
    revalidateTarget: async () => {
      originalRevalidations += 1;
      return { state: 'fresh', entity };
    },
    approve: async () => {
      approvalEntered();
      await approvalGate;
      return true;
    },
  };

  const runtime = new ComputerTaskRuntime(program, registry(desktop), {
    executionId: EXECUTION_ID,
    hooks,
  });
  const pending = runtime.run();
  await entered;

  hooks.revalidateTarget = async () => {
    mutatedRevalidations += 1;
    return { state: 'stale', evidence: ['mutated-revalidator'] };
  };
  releaseApproval();

  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(desktop.actions, 1);
  assert.equal(originalRevalidations, 2);
  assert.equal(mutatedRevalidations, 0);
  assert.equal(result.evidence?.includes('mutated-revalidator'), false);
});
