import assert from 'node:assert/strict';
import test from 'node:test';

import {
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEnvironmentAdapter,
  type ComputerEnvironmentKind,
  type ComputerObservationChannel,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import { type ComputerTaskProgram } from '../src/computer/computerTask.js';
import {
  COMPUTER_TASK_MAX_RETAINED_OBSERVATIONS,
  ComputerTaskRuntime,
} from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '11111111111111111111111111111111';

type ActHandler = (request: ComputerActionRequest) => Promise<ComputerActionResult> | ComputerActionResult;
type ObserveHandler = (request: ComputerObservationRequest) => Promise<ComputerObservationEnvelope> | ComputerObservationEnvelope;

class SyntheticAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  readonly actions: ComputerActionRequest[] = [];
  readonly observations: ComputerObservationRequest[] = [];
  private sequence = 0;

  constructor(
    id: string,
    kind: ComputerEnvironmentKind,
    capabilities: readonly string[],
    private readonly onAct?: ActHandler,
    private readonly onObserve?: ObserveHandler,
  ) {
    this.descriptor = Object.freeze({ id, kind, version: 'integration-1', capabilities: Object.freeze([...capabilities]) });
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    this.observations.push(request);
    if (this.onObserve) return this.onObserve(request);
    return {
      adapterId: this.descriptor.id,
      environment: this.descriptor.kind,
      channel: request.channel,
      sequence: ++this.sequence,
      complete: true,
      truncated: false,
      surface: request.surface,
      target: request.target,
      data: Object.freeze({ synthetic: true }),
    };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actions.push(request);
    if (this.onAct) return this.onAct(request);
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified', evidence: ['synthetic-ok'] };
  }
}

function registryWith(...adapters: SyntheticAdapter[]): ComputerEnvironmentRegistry {
  const registry = new ComputerEnvironmentRegistry();
  for (const adapter of adapters) registry.register(adapter);
  return registry;
}

function observeStep(id: string, adapterId: string, channel: ComputerObservationChannel, next?: string) {
  return { kind: 'observe' as const, id, request: { adapterId, channel }, next };
}

function actionStep(
  id: string,
  adapterId: string,
  capability: string,
  options: Partial<Extract<ComputerTaskProgram['steps'][number], { kind: 'action' }>> = {},
) {
  return {
    kind: 'action' as const,
    id,
    request: {
      adapterId,
      actionId: id,
      capability,
      effect: 'local-reversible' as const,
      idempotency: 'idempotent' as const,
    },
    ...options,
  };
}

test('matrix: browser -> filesystem -> compute -> terminal plus process observation composes through one task runtime', async () => {
  const browser = new SyntheticAdapter('browser:synthetic', 'browser', ['browser.observe']);
  const filesystem = new SyntheticAdapter('fs:synthetic', 'filesystem', ['filesystem.read']);
  const compute = new SyntheticAdapter('compute:synthetic', 'local-compute', ['local-compute.run']);
  const process = new SyntheticAdapter('process:synthetic', 'process', ['process.observe']);
  const terminal = new SyntheticAdapter('terminal:synthetic', 'terminal', ['terminal.execute.argv']);
  const registry = registryWith(browser, filesystem, compute, process, terminal);

  const program: ComputerTaskProgram = {
    id: 'cross-adapter-pipeline',
    entry: 'browser-read',
    steps: [
      observeStep('browser-read', browser.descriptor.id, 'semantic-ui', 'fs-read'),
      observeStep('fs-read', filesystem.descriptor.id, 'filesystem', 'compute-run'),
      actionStep('compute-run', compute.descriptor.id, 'local-compute.run', { onSuccess: 'process-read' }),
      observeStep('process-read', process.descriptor.id, 'process', 'terminal-run'),
      actionStep('terminal-run', terminal.descriptor.id, 'terminal.execute.argv', {
        request: {
          adapterId: terminal.descriptor.id,
          actionId: 'terminal-run',
          capability: 'terminal.execute.argv',
          effect: 'process-execution',
          idempotency: 'non-idempotent',
          payload: { argv: ['node', '-e', 'process.stdout.write("ok")'] },
        },
        checkpointBinding: 'terminal-command-v1',
      }),
    ],
  };

  const result = await new ComputerTaskRuntime(program, registry, {
    executionId: EXECUTION_ID,
    hooks: { approve: async () => true },
  }).run();

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.observations.map((entry) => entry.adapterId), [browser.descriptor.id, filesystem.descriptor.id, process.descriptor.id]);
  assert.equal(compute.actions.length, 1);
  assert.equal(terminal.actions.length, 1);
  assert.equal(terminal.actions[0]?.adapterId, terminal.descriptor.id);
});

test('target generation changes between freshness observation and action, so dispatch is suppressed', async () => {
  const desktop = new SyntheticAdapter('desktop:synthetic', 'desktop-ui', ['desktop.activate']);
  const registry = registryWith(desktop);
  const entity = {
    adapterId: desktop.descriptor.id,
    environment: 'desktop-ui' as const,
    kind: 'ui-control' as const,
    entityId: 'control:save',
    surfaceId: 'window:1',
    generation: 1,
  };
  let calls = 0;
  const program: ComputerTaskProgram = {
    id: 'target-generation-change',
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

  const result = await new ComputerTaskRuntime(program, registry, {
    executionId: EXECUTION_ID,
    hooks: {
      revalidateTarget: async () => ({
        state: 'fresh',
        entity: { ...entity, generation: ++calls === 1 ? 1 : 2 },
      }),
    },
  }).run();

  assert.equal(result.status, 'stale-target');
  assert.equal(desktop.actions.length, 0);
  assert.ok(result.evidence?.includes('target-changed-before-dispatch'));
});

test('approval may complete but a target generation change before dispatch still suppresses the action', async () => {
  const remote = new SyntheticAdapter('remote:synthetic', 'remote-session', ['remote.control']);
  const registry = registryWith(remote);
  const entity = {
    adapterId: remote.descriptor.id,
    environment: 'remote-session' as const,
    kind: 'remote-host' as const,
    entityId: 'session:1',
    generation: 7,
  };
  let freshness = 0;
  let approvals = 0;
  const program: ComputerTaskProgram = {
    id: 'approval-generation-race',
    entry: 'remote-control',
    steps: [{
      kind: 'action',
      id: 'remote-control',
      request: {
        adapterId: remote.descriptor.id,
        actionId: 'remote-control',
        capability: 'remote.control',
        effect: 'remote-execution',
        idempotency: 'non-idempotent',
        target: entity,
      },
      target: { entity },
    }],
  };

  const result = await new ComputerTaskRuntime(program, registry, {
    executionId: EXECUTION_ID,
    hooks: {
      approve: async () => { approvals += 1; return true; },
      revalidateTarget: async () => ({
        state: 'fresh',
        entity: { ...entity, generation: ++freshness === 1 ? 7 : 8 },
      }),
    },
  }).run();

  assert.equal(approvals, 1);
  assert.equal(result.status, 'stale-target');
  assert.equal(remote.actions.length, 0);
});

test('unknown dispatch crosses checkpoint/resume without replaying the action', async () => {
  const firstAdapter = new SyntheticAdapter('terminal:unknown', 'terminal', ['terminal.execute.argv'], () => ({
    status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: ['transport-ambiguous'],
  }));
  const firstRegistry = registryWith(firstAdapter);
  const program: ComputerTaskProgram = {
    id: 'unknown-dispatch-resume',
    entry: 'execute',
    steps: [actionStep('execute', firstAdapter.descriptor.id, 'terminal.execute.argv', { maxRetries: 3 })],
  };
  const runtime = new ComputerTaskRuntime(program, firstRegistry, { executionId: EXECUTION_ID });
  const first = await runtime.run();
  assert.equal(first.status, 'unknown-dispatch');
  assert.equal(firstAdapter.actions.length, 1);

  const resumedAdapter = new SyntheticAdapter('terminal:unknown', 'terminal', ['terminal.execute.argv']);
  const resumed = await new ComputerTaskRuntime(program, registryWith(resumedAdapter), {
    executionId: EXECUTION_ID,
    checkpoint: runtime.checkpoint(),
  }).run();
  assert.equal(resumed.status, 'reconciliation-required');
  assert.equal(resumedAdapter.actions.length, 0);
});

test('verifier throw after dispatched-once is non-replayable across adapter-boundary observations', async () => {
  const browser = new SyntheticAdapter('browser:verify', 'browser', ['browser.observe']);
  const terminal = new SyntheticAdapter('terminal:verify', 'terminal', ['terminal.execute.argv']);
  const registry = registryWith(browser, terminal);
  const program: ComputerTaskProgram = {
    id: 'verifier-throw-cross-adapter',
    entry: 'browser-read',
    steps: [
      observeStep('browser-read', browser.descriptor.id, 'semantic-ui', 'execute'),
      actionStep('execute', terminal.descriptor.id, 'terminal.execute.argv', { verification: 'terminal.verify' }),
    ],
  };
  const hooks = { verifiers: { 'terminal.verify': async () => { throw new Error('synthetic verifier failure'); } } };
  const runtime = new ComputerTaskRuntime(program, registry, { executionId: EXECUTION_ID, hooks });
  const first = await runtime.run();
  assert.equal(first.status, 'unverified');
  assert.equal(terminal.actions.length, 1);

  const resumedTerminal = new SyntheticAdapter('terminal:verify', 'terminal', ['terminal.execute.argv']);
  const resumed = await new ComputerTaskRuntime(program, registryWith(
    new SyntheticAdapter('browser:verify', 'browser', ['browser.observe']),
    resumedTerminal,
  ), { executionId: EXECUTION_ID, checkpoint: runtime.checkpoint(), hooks }).run();
  assert.equal(resumed.status, 'reconciliation-required');
  assert.equal(resumedTerminal.actions.length, 0);
});

test('completed action in a checkpoint is skipped and never redispatched while later adapters continue', async () => {
  const compute = new SyntheticAdapter('compute:resume', 'local-compute', ['local-compute.run']);
  const filesystem = new SyntheticAdapter('fs:resume', 'filesystem', ['filesystem.read']);
  const program: ComputerTaskProgram = {
    id: 'completed-never-redispatched',
    entry: 'compute',
    steps: [
      actionStep('compute', compute.descriptor.id, 'local-compute.run', { onSuccess: 'read' }),
      observeStep('read', filesystem.descriptor.id, 'filesystem'),
    ],
  };
  const runtime = new ComputerTaskRuntime(program, registryWith(compute, filesystem), { executionId: EXECUTION_ID });
  const first = await runtime.run();
  assert.equal(first.status, 'completed');
  assert.equal(compute.actions.length, 1);

  const compute2 = new SyntheticAdapter('compute:resume', 'local-compute', ['local-compute.run']);
  const filesystem2 = new SyntheticAdapter('fs:resume', 'filesystem', ['filesystem.read']);
  const resumed = await new ComputerTaskRuntime(program, registryWith(compute2, filesystem2), {
    executionId: EXECUTION_ID,
    checkpoint: runtime.checkpoint(),
  }).run();
  assert.equal(resumed.status, 'completed');
  assert.equal(compute2.actions.length, 0);
});

test('side-effecting action retries only after definite not-dispatched and never after unknown dispatch', async () => {
  let calls = 0;
  const retrying = new SyntheticAdapter('terminal:retry', 'terminal', ['terminal.execute.argv'], () => {
    calls += 1;
    return calls === 1
      ? { status: 'failed', dispatch: 'not-dispatched', verification: 'unverified', evidence: ['spawn-not-started'] }
      : { status: 'completed', dispatch: 'dispatched-once', verification: 'verified', evidence: ['spawn-ack'] };
  });
  const retryProgram: ComputerTaskProgram = {
    id: 'definite-retry', entry: 'execute',
    steps: [actionStep('execute', retrying.descriptor.id, 'terminal.execute.argv', { maxRetries: 2 })],
  };
  assert.equal((await new ComputerTaskRuntime(retryProgram, registryWith(retrying), { executionId: EXECUTION_ID }).run()).status, 'completed');
  assert.equal(retrying.actions.length, 2);

  const unknown = new SyntheticAdapter('terminal:no-retry', 'terminal', ['terminal.execute.argv'], () => ({
    status: 'unknown', dispatch: 'unknown', verification: 'unverified', evidence: ['dispatch-unknown'],
  }));
  const unknownProgram: ComputerTaskProgram = {
    id: 'unknown-no-retry', entry: 'execute',
    steps: [actionStep('execute', unknown.descriptor.id, 'terminal.execute.argv', { maxRetries: 3 })],
  };
  assert.equal((await new ComputerTaskRuntime(unknownProgram, registryWith(unknown), { executionId: EXECUTION_ID }).run()).status, 'unknown-dispatch');
  assert.equal(unknown.actions.length, 1);
});

test('observation retention stays bounded across many adapters and retains metadata only', async () => {
  const adapters = Array.from({ length: 8 }, (_, index) => new SyntheticAdapter(
    `browser:bounded:${index}`,
    'browser',
    ['browser.observe'],
    undefined,
    (request) => ({
      adapterId: `browser:bounded:${index}`,
      environment: 'browser',
      channel: request.channel,
      sequence: index + 1,
      complete: true,
      truncated: false,
      data: { privateSentinel: `secret-${index}` },
    }),
  ));
  const registry = registryWith(...adapters);
  const count = COMPUTER_TASK_MAX_RETAINED_OBSERVATIONS + 12;
  const steps = Array.from({ length: count }, (_, index) => observeStep(
    `observe-${index}`,
    adapters[index % adapters.length]!.descriptor.id,
    'semantic-ui',
    index + 1 < count ? `observe-${index + 1}` : undefined,
  ));
  const result = await new ComputerTaskRuntime({ id: 'bounded-multi-adapter-observations', entry: 'observe-0', steps }, registry, {
    executionId: EXECUTION_ID,
  }).run();

  assert.equal(result.status, 'completed');
  assert.equal(result.observations.length, COMPUTER_TASK_MAX_RETAINED_OBSERVATIONS);
  assert.equal(result.observationsDropped, 12);
  assert.equal(JSON.stringify(result.observations).includes('secret-'), false);
  assert.equal(result.observations.some((entry) => 'data' in entry), false);
});

test('caller mutation during awaited approval and verification gates cannot alter runtime-owned requests or results', async () => {
  const mutablePayload = { value: 'original' };
  const sharedResult: ComputerActionResult = {
    status: 'completed', dispatch: 'dispatched-once', verification: 'verified', evidence: ['shared-result-ok'],
  };
  const terminal = new SyntheticAdapter('terminal:mutation', 'terminal', ['terminal.execute.argv'], () => sharedResult);
  const program: ComputerTaskProgram = {
    id: 'mutation-gates', entry: 'execute', steps: [{
      ...actionStep('execute', terminal.descriptor.id, 'terminal.execute.argv', {
        verification: 'verify',
        checkpointBinding: 'mutation-gates-v1',
      }),
      request: {
        adapterId: terminal.descriptor.id,
        actionId: 'execute',
        capability: 'terminal.execute.argv',
        effect: 'process-execution',
        idempotency: 'non-idempotent',
        payload: mutablePayload,
      },
    }],
  };
  const result = await new ComputerTaskRuntime(program, registryWith(terminal), {
    executionId: EXECUTION_ID,
    hooks: {
      approve: async () => { mutablePayload.value = 'mutated-after-snapshot'; return true; },
      verifiers: {
        verify: async ({ adapterResult }) => {
          sharedResult.status = 'failed';
          sharedResult.dispatch = 'unknown';
          sharedResult.verification = 'unverified';
          assert.equal(adapterResult.status, 'completed');
          assert.equal(adapterResult.dispatch, 'dispatched-once');
          return { state: 'verified', evidence: ['verifier-ok'] };
        },
      },
    },
  }).run();

  assert.equal(result.status, 'completed');
  assert.deepEqual(terminal.actions[0]?.payload, { value: 'original' });
  assert.notEqual(terminal.actions[0]?.payload, mutablePayload);
});

test('malformed hostile adapter action result becomes unknown dispatch instead of escaping as safe-to-retry', async () => {
  let getterReads = 0;
  const hostile = new SyntheticAdapter('remote:hostile', 'remote-session', ['remote.control'], () => {
    const result = {} as ComputerActionResult;
    Object.defineProperty(result, 'status', { enumerable: true, get: () => { getterReads += 1; throw new Error('hostile getter'); } });
    return result;
  });
  const program: ComputerTaskProgram = {
    id: 'hostile-result', entry: 'control', steps: [actionStep('control', hostile.descriptor.id, 'remote.control')],
  };
  const result = await new ComputerTaskRuntime(program, registryWith(hostile), { executionId: EXECUTION_ID }).run();
  assert.equal(result.status, 'unknown-dispatch');
  assert.equal(hostile.actions.length, 1);
  assert.ok(getterReads <= 1);
});

test('acquisition limits reach the adapter before synthetic observation materialization', async () => {
  let materialized = 0;
  const filesystem = new SyntheticAdapter('fs:limits', 'filesystem', ['filesystem.read'], undefined, (request) => {
    const maxItems = request.limits?.maxItems ?? 0;
    const items = Array.from({ length: maxItems }, (_, index) => {
      materialized += 1;
      return `file-${index}`;
    });
    return {
      adapterId: 'fs:limits', environment: 'filesystem', channel: request.channel, sequence: 1,
      complete: maxItems >= 100, truncated: maxItems < 100, data: { items },
    };
  });
  const registry = registryWith(filesystem);
  const observation = await registry.observe({
    adapterId: filesystem.descriptor.id,
    channel: 'filesystem',
    limits: { maxItems: 3, maxTextBytes: 128, maxDepth: 2 },
  });
  assert.equal(materialized, 3);
  assert.equal(observation.truncated, true);
  assert.equal(filesystem.observations[0]?.limits?.maxItems, 3);
});

test('targetless actions route strictly by adapterId across same-kind adapters', async () => {
  const left = new SyntheticAdapter('compute:left', 'local-compute', ['local-compute.run']);
  const right = new SyntheticAdapter('compute:right', 'local-compute', ['local-compute.run']);
  const program: ComputerTaskProgram = {
    id: 'targetless-routing', entry: 'run-right',
    steps: [actionStep('run-right', right.descriptor.id, 'local-compute.run')],
  };
  const result = await new ComputerTaskRuntime(program, registryWith(left, right), { executionId: EXECUTION_ID }).run();
  assert.equal(result.status, 'completed');
  assert.equal(left.actions.length, 0);
  assert.equal(right.actions.length, 1);
  assert.equal(right.actions[0]?.target, undefined);
});

test('desktop realtime synthetic control and remote-session synthetic transport run through task runtime', async () => {
  const desktop = new SyntheticAdapter('desktop:realtime', 'desktop-ui', ['desktop.realtime.control']);
  const remote = new SyntheticAdapter('remote:transport', 'remote-session', ['remote.transport.send']);
  const program: ComputerTaskProgram = {
    id: 'realtime-remote-composition', entry: 'desktop-control', steps: [
      actionStep('desktop-control', desktop.descriptor.id, 'desktop.realtime.control', { onSuccess: 'remote-send' }),
      actionStep('remote-send', remote.descriptor.id, 'remote.transport.send'),
    ],
  };
  const result = await new ComputerTaskRuntime(program, registryWith(desktop, remote), { executionId: EXECUTION_ID }).run();
  assert.equal(result.status, 'completed');
  assert.equal(desktop.actions.length, 1);
  assert.equal(remote.actions.length, 1);
});
