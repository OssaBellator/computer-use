import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import { ComputerAdapterRoutingError, ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '44444444444444444444444444444444';

class ActionSink implements ComputerEnvironmentAdapter {
  readonly descriptor = Object.freeze({
    id: 'terminal:observation-boundary',
    kind: 'terminal' as const,
    version: '1',
    capabilities: Object.freeze(['terminal.execute.argv']),
  });
  actions = 0;

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    return {
      adapterId: this.descriptor.id,
      environment: this.descriptor.kind,
      channel: request.channel,
      sequence: 1,
      complete: true,
      truncated: false,
      data: null,
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actions += 1;
    return { status: 'completed', dispatch: 'dispatched-once', verification: 'verified', evidence: ['synthetic-ok'] };
  }
}

function program(browserId: string, terminalId: string): ComputerTaskProgram {
  return {
    id: 'observation-boundary-pipeline',
    entry: 'observe',
    steps: [
      {
        kind: 'observe',
        id: 'observe',
        request: { adapterId: browserId, channel: 'semantic-ui' },
        next: 'execute',
      },
      {
        kind: 'action',
        id: 'execute',
        request: {
          adapterId: terminalId,
          actionId: 'execute',
          capability: 'terminal.execute.argv',
          effect: 'local-reversible',
          idempotency: 'idempotent',
        },
      },
    ],
  };
}

test('hostile observation data accessor remains opaque across registry and runtime retention', async () => {
  let dataReads = 0;
  const browser: ComputerEnvironmentAdapter = {
    descriptor: {
      id: 'browser:hostile-data',
      kind: 'browser',
      version: '1',
      capabilities: ['browser.observe'],
    },
    async observe(request) {
      const envelope: Record<string, unknown> = {
        adapterId: 'browser:hostile-data',
        environment: 'browser',
        channel: request.channel,
        sequence: 1,
        complete: true,
        truncated: false,
      };
      Object.defineProperty(envelope, 'data', {
        enumerable: true,
        get() {
          dataReads += 1;
          throw new Error('observation data must stay opaque');
        },
      });
      return envelope as unknown as ComputerObservationEnvelope;
    },
    async act() {
      return { status: 'unsupported', dispatch: 'not-dispatched', verification: 'unverified' };
    },
  };
  const terminal = new ActionSink();
  const registry = new ComputerEnvironmentRegistry();
  registry.register(browser);
  registry.register(terminal);

  const result = await new ComputerTaskRuntime(program(browser.descriptor.id, terminal.descriptor.id), registry, {
    executionId: EXECUTION_ID,
  }).run();

  assert.equal(result.status, 'completed');
  assert.equal(dataReads, 0);
  assert.equal(terminal.actions, 1);
  assert.equal('data' in result.observations[0]!, false);
});

test('hostile proxy stored as observation data is never traversed or materialized', async () => {
  let traps = 0;
  const hostile = new Proxy({}, {
    get() { traps += 1; throw new Error('data get trap'); },
    ownKeys() { traps += 1; throw new Error('data ownKeys trap'); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error('data descriptor trap'); },
  });
  const browser: ComputerEnvironmentAdapter = {
    descriptor: {
      id: 'browser:hostile-proxy-data',
      kind: 'browser',
      version: '1',
      capabilities: ['browser.observe'],
    },
    async observe(request) {
      return {
        adapterId: 'browser:hostile-proxy-data',
        environment: 'browser',
        channel: request.channel,
        sequence: 1,
        complete: true,
        truncated: false,
        data: hostile,
      };
    },
    async act() {
      return { status: 'unsupported', dispatch: 'not-dispatched', verification: 'unverified' };
    },
  };
  const terminal = new ActionSink();
  const registry = new ComputerEnvironmentRegistry();
  registry.register(browser);
  registry.register(terminal);

  const result = await new ComputerTaskRuntime(program(browser.descriptor.id, terminal.descriptor.id), registry, {
    executionId: EXECUTION_ID,
  }).run();

  assert.equal(result.status, 'completed');
  assert.equal(traps, 0);
  assert.equal(terminal.actions, 1);
  assert.doesNotThrow(() => JSON.stringify(result));
});

test('malformed observation metadata rejects the pipeline before a later adapter can act', async () => {
  const browser: ComputerEnvironmentAdapter = {
    descriptor: {
      id: 'browser:malformed-envelope',
      kind: 'browser',
      version: '1',
      capabilities: ['browser.observe'],
    },
    async observe() {
      return {
        adapterId: 'browser:malformed-envelope',
        environment: 'browser',
        channel: 'filesystem',
        sequence: 1,
        complete: true,
        truncated: false,
        data: null,
      };
    },
    async act() {
      return { status: 'unsupported', dispatch: 'not-dispatched', verification: 'unverified' };
    },
  };
  const terminal = new ActionSink();
  const registry = new ComputerEnvironmentRegistry();
  registry.register(browser);
  registry.register(terminal);

  await assert.rejects(
    new ComputerTaskRuntime(program(browser.descriptor.id, terminal.descriptor.id), registry, {
      executionId: EXECUTION_ID,
    }).run(),
    (error: unknown) => error instanceof ComputerAdapterRoutingError && error.code === 'invalid-observation-response',
  );
  assert.equal(terminal.actions, 0);
});
