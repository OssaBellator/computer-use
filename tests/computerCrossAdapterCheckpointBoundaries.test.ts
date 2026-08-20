import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerEnvironmentKind,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '22222222222222222222222222222222';

class Adapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  readonly actions: ComputerActionRequest[] = [];
  readonly observations: ComputerObservationRequest[] = [];

  constructor(
    id: string,
    kind: ComputerEnvironmentKind,
    capabilities: readonly string[],
    private readonly result: ComputerActionResult = {
      status: 'completed',
      dispatch: 'dispatched-once',
      verification: 'verified',
      evidence: ['synthetic-ok'],
    },
  ) {
    this.descriptor = Object.freeze({ id, kind, version: 'checkpoint-integration-1', capabilities: Object.freeze([...capabilities]) });
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    this.observations.push(request);
    return {
      adapterId: this.descriptor.id,
      environment: this.descriptor.kind,
      channel: request.channel,
      sequence: this.observations.length,
      complete: true,
      truncated: false,
      target: request.target,
      surface: request.surface,
      data: { privateValue: 'never-retain-raw-observation' },
    };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actions.push(request);
    return this.result;
  }
}

function registry(...adapters: Adapter[]): ComputerEnvironmentRegistry {
  const value = new ComputerEnvironmentRegistry();
  for (const adapter of adapters) value.register(adapter);
  return value;
}

function action(id: string, adapterId: string, capability: string, onSuccess?: string) {
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
    onSuccess,
  };
}

test('checkpoint JSON round-trip resumes at a later adapter without replaying completed work', async () => {
  const compute = new Adapter('compute:checkpoint', 'local-compute', ['compute.run']);
  const filesystem = new Adapter('fs:checkpoint', 'filesystem', ['filesystem.read']);
  const program: ComputerTaskProgram = {
    id: 'checkpoint-cross-adapter-json-roundtrip',
    entry: 'compute',
    steps: [
      action('compute', compute.descriptor.id, 'compute.run', 'read'),
      { kind: 'observe', id: 'read', request: { adapterId: filesystem.descriptor.id, channel: 'filesystem' } },
    ],
  };

  const first = new ComputerTaskRuntime(program, registry(compute), { executionId: EXECUTION_ID });
  const stopped = await first.run();
  assert.equal(stopped.status, 'adapter-not-found');
  assert.equal(compute.actions.length, 1);

  const serialized = JSON.stringify(first.checkpoint());
  assert.equal(serialized.includes('never-retain-raw-observation'), false);
  const checkpoint = JSON.parse(serialized);

  const resumedCompute = new Adapter('compute:checkpoint', 'local-compute', ['compute.run']);
  const resumedFilesystem = new Adapter('fs:checkpoint', 'filesystem', ['filesystem.read']);
  const resumed = await new ComputerTaskRuntime(program, registry(resumedCompute, resumedFilesystem), {
    executionId: EXECUTION_ID,
    checkpoint,
  }).run();

  assert.equal(resumed.status, 'completed');
  assert.equal(resumedCompute.actions.length, 0);
  assert.equal(resumedFilesystem.observations.length, 1);
});

test('unsupported action preflight checkpoint resumes onto the newly capable adapter exactly once', async () => {
  const browser = new Adapter('browser:checkpoint', 'browser', ['browser.observe']);
  const terminalWithoutCapability = new Adapter('terminal:checkpoint', 'terminal', []);
  const program: ComputerTaskProgram = {
    id: 'checkpoint-capability-boundary',
    entry: 'observe',
    steps: [
      { kind: 'observe', id: 'observe', request: { adapterId: browser.descriptor.id, channel: 'semantic-ui' }, next: 'execute' },
      action('execute', terminalWithoutCapability.descriptor.id, 'terminal.execute.argv'),
    ],
  };

  const first = new ComputerTaskRuntime(program, registry(browser, terminalWithoutCapability), { executionId: EXECUTION_ID });
  const stopped = await first.run();
  assert.equal(stopped.status, 'unsupported');
  assert.equal(browser.observations.length, 1);
  assert.equal(terminalWithoutCapability.actions.length, 0);

  const capableTerminal = new Adapter('terminal:checkpoint', 'terminal', ['terminal.execute.argv']);
  const resumed = await new ComputerTaskRuntime(program, registry(new Adapter('browser:checkpoint', 'browser', ['browser.observe']), capableTerminal), {
    executionId: EXECUTION_ID,
    checkpoint: JSON.parse(JSON.stringify(first.checkpoint())),
  }).run();

  assert.equal(resumed.status, 'completed');
  assert.equal(capableTerminal.actions.length, 1);
});

test('unknown dispatch remains reconciliation-required after checkpoint serialization and adapter replacement', async () => {
  const remote = new Adapter('remote:checkpoint', 'remote-session', ['remote.control'], {
    status: 'unknown',
    dispatch: 'unknown',
    verification: 'unverified',
    evidence: ['transport-ambiguous'],
  });
  const program: ComputerTaskProgram = {
    id: 'checkpoint-unknown-json-roundtrip',
    entry: 'remote',
    steps: [{
      kind: 'action',
      id: 'remote',
      request: {
        adapterId: remote.descriptor.id,
        actionId: 'remote',
        capability: 'remote.control',
        effect: 'remote-execution',
        idempotency: 'non-idempotent',
      },
    }],
  };

  const first = new ComputerTaskRuntime(program, registry(remote), { executionId: EXECUTION_ID });
  const ambiguous = await first.run();
  assert.equal(ambiguous.status, 'unknown-dispatch');
  assert.equal(remote.actions.length, 1);

  const replacement = new Adapter('remote:checkpoint', 'remote-session', ['remote.control']);
  const resumed = await new ComputerTaskRuntime(program, registry(replacement), {
    executionId: EXECUTION_ID,
    checkpoint: JSON.parse(JSON.stringify(first.checkpoint())),
  }).run();

  assert.equal(resumed.status, 'reconciliation-required');
  assert.equal(replacement.actions.length, 0);
});
