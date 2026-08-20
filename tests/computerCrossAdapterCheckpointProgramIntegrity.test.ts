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
import {
  decodeComputerTaskCheckpoint,
  encodeComputerTaskCheckpoint,
  type ComputerTaskCheckpoint,
} from '../src/computer/computerTaskCheckpoint.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = 'ffffffffffffffffffffffffffffffff';

class IntegrityAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  actions = 0;
  observations = 0;

  constructor(id: string, kind: ComputerEnvironmentKind, capabilities: readonly string[]) {
    this.descriptor = Object.freeze({ id, kind, version: 'checkpoint-program-integrity-1', capabilities: Object.freeze([...capabilities]) });
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    this.observations += 1;
    return {
      adapterId: this.descriptor.id,
      environment: this.descriptor.kind,
      channel: request.channel,
      sequence: this.observations,
      complete: true,
      truncated: false,
      data: null,
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actions += 1;
    return {
      status: 'completed',
      dispatch: 'dispatched-once',
      verification: 'verified',
      evidence: ['integrity-adapter-ok'],
    };
  }
}

function registry(...adapters: ComputerEnvironmentAdapter[]): ComputerEnvironmentRegistry {
  const value = new ComputerEnvironmentRegistry();
  for (const adapter of adapters) value.register(adapter);
  return value;
}

function program(browserId: string, remoteId: string, capability = 'remote.control'): ComputerTaskProgram {
  return {
    id: 'checkpoint-program-integrity',
    entry: 'observe',
    steps: [
      {
        kind: 'observe',
        id: 'observe',
        request: { adapterId: browserId, channel: 'semantic-ui' },
        next: 'remote',
      },
      {
        kind: 'action',
        id: 'remote',
        request: {
          adapterId: remoteId,
          actionId: 'remote',
          capability,
          effect: 'remote-execution',
          idempotency: 'non-idempotent',
        },
      },
    ],
  };
}

async function checkpointAtMissingRemote(browserId: string, remoteId: string): Promise<ComputerTaskCheckpoint> {
  const browser = new IntegrityAdapter(browserId, 'browser', ['browser.observe']);
  const task = program(browserId, remoteId);
  const runtime = new ComputerTaskRuntime(task, registry(browser), { executionId: EXECUTION_ID });
  const stopped = await runtime.run();

  assert.equal(stopped.status, 'unsupported');
  assert.equal(stopped.nextStepId, 'remote');
  assert.equal(stopped.stepsExecuted, 1);
  assert.equal(browser.observations, 1);

  return decodeComputerTaskCheckpoint(encodeComputerTaskCheckpoint(runtime.checkpoint()));
}

test('portable checkpoint rejects substitution of the downstream adapterId before replacement adapter dispatch', async () => {
  const browserId = 'browser:checkpoint-integrity-adapter';
  const originalRemoteId = 'remote:checkpoint-integrity-original';
  const checkpoint = await checkpointAtMissingRemote(browserId, originalRemoteId);
  const substituted = new IntegrityAdapter('remote:checkpoint-integrity-substituted', 'remote-session', ['remote.control']);
  const browser = new IntegrityAdapter(browserId, 'browser', ['browser.observe']);
  const modified = program(browserId, substituted.descriptor.id);

  assert.throws(
    () => new ComputerTaskRuntime(modified, registry(browser, substituted), {
      executionId: EXECUTION_ID,
      checkpoint,
      hooks: { approve: async () => true },
    }),
    /computer task checkpoint does not match program/,
  );

  assert.equal(browser.observations, 0);
  assert.equal(substituted.actions, 0);
});

test('portable checkpoint rejects downstream capability substitution even when adapterId is unchanged', async () => {
  const browserId = 'browser:checkpoint-integrity-capability';
  const remoteId = 'remote:checkpoint-integrity-capability';
  const checkpoint = await checkpointAtMissingRemote(browserId, remoteId);
  const remote = new IntegrityAdapter(remoteId, 'remote-session', ['remote.control', 'remote.control.admin']);
  const browser = new IntegrityAdapter(browserId, 'browser', ['browser.observe']);
  const modified = program(browserId, remoteId, 'remote.control.admin');

  assert.throws(
    () => new ComputerTaskRuntime(modified, registry(browser, remote), {
      executionId: EXECUTION_ID,
      checkpoint,
      hooks: { approve: async () => true },
    }),
    /computer task checkpoint does not match program/,
  );

  assert.equal(browser.observations, 0);
  assert.equal(remote.actions, 0);
});

test('unchanged program may resume with a replacement implementation that preserves the same adapter authority', async () => {
  const browserId = 'browser:checkpoint-integrity-control';
  const remoteId = 'remote:checkpoint-integrity-control';
  const checkpoint = await checkpointAtMissingRemote(browserId, remoteId);
  const browser = new IntegrityAdapter(browserId, 'browser', ['browser.observe']);
  const replacementRemote = new IntegrityAdapter(remoteId, 'remote-session', ['remote.control']);

  const result = await new ComputerTaskRuntime(program(browserId, remoteId), registry(browser, replacementRemote), {
    executionId: EXECUTION_ID,
    checkpoint,
    hooks: { approve: async () => true },
  }).run();

  assert.equal(result.status, 'completed');
  assert.equal(browser.observations, 0);
  assert.equal(replacementRemote.actions, 1);
});
