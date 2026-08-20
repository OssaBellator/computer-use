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

const EXECUTION_ID = '99999999999999999999999999999999';

class ObservationAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  readonly observations: ComputerObservationRequest[] = [];
  actions = 0;

  constructor(
    id: string,
    kind: ComputerEnvironmentKind,
    private readonly beforeObserve?: () => Promise<void>,
  ) {
    this.descriptor = Object.freeze({ id, kind, version: 'observation-mutation-1', capabilities: Object.freeze(['fixture.observe']) });
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    this.observations.push(request);
    if (this.beforeObserve) await this.beforeObserve();
    return {
      adapterId: this.descriptor.id,
      environment: this.descriptor.kind,
      channel: request.channel,
      sequence: this.observations.length,
      complete: true,
      truncated: false,
      data: { materializedItems: request.limits?.maxItems ?? null },
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actions += 1;
    return {
      status: 'completed',
      dispatch: 'not-dispatched',
      verification: 'verified',
      evidence: ['mutation-fixture-ok'],
    };
  }
}

function registry(...adapters: ComputerEnvironmentAdapter[]): ComputerEnvironmentRegistry {
  const value = new ComputerEnvironmentRegistry();
  for (const adapter of adapters) value.register(adapter);
  return value;
}

test('caller mutation of a future observation route and limits during an awaited adapter cannot alter the runtime snapshot', async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observing = new Promise<void>((resolve) => { entered = resolve; });

  const first = new ObservationAdapter('browser:mutation-gate', 'browser', async () => {
    entered();
    await gate;
  });
  const intended = new ObservationAdapter('filesystem:mutation-intended', 'filesystem');
  const hijacker = new ObservationAdapter('process:mutation-hijacker', 'process');

  const futureRequest: any = {
    adapterId: intended.descriptor.id,
    channel: 'filesystem',
    limits: { maxItems: 2, maxTextBytes: 32 },
  };
  const program: ComputerTaskProgram = {
    id: 'observation-request-mutation-boundary',
    entry: 'first',
    steps: [
      {
        kind: 'observe',
        id: 'first',
        request: { adapterId: first.descriptor.id, channel: 'semantic-ui' },
        next: 'second',
      },
      {
        kind: 'observe',
        id: 'second',
        request: futureRequest,
      },
    ],
  };

  const runtime = new ComputerTaskRuntime(program, registry(first, intended, hijacker), { executionId: EXECUTION_ID });
  const pending = runtime.run();
  await observing;

  futureRequest.adapterId = hijacker.descriptor.id;
  futureRequest.channel = 'process';
  futureRequest.limits.maxItems = 999_999;
  futureRequest.limits.maxTextBytes = 999_999;
  release();

  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(first.observations.length, 1);
  assert.equal(intended.observations.length, 1);
  assert.equal(hijacker.observations.length, 0);
  assert.equal(intended.observations[0]?.adapterId, intended.descriptor.id);
  assert.equal(intended.observations[0]?.channel, 'filesystem');
  assert.deepEqual(intended.observations[0]?.limits, { maxItems: 2, maxTextBytes: 32 });
});

test('caller can replace a future request property with a hostile accessor after runtime construction without it being evaluated', async () => {
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const observing = new Promise<void>((resolve) => { entered = resolve; });

  const first = new ObservationAdapter('browser:accessor-gate', 'browser', async () => {
    entered();
    await gate;
  });
  const intended = new ObservationAdapter('filesystem:accessor-intended', 'filesystem');
  const hijacker = new ObservationAdapter('process:accessor-hijacker', 'process');

  const futureRequest: any = {
    adapterId: intended.descriptor.id,
    channel: 'filesystem',
    limits: { maxItems: 3 },
  };
  const program: ComputerTaskProgram = {
    id: 'observation-request-accessor-mutation-boundary',
    entry: 'first',
    steps: [
      { kind: 'observe', id: 'first', request: { adapterId: first.descriptor.id, channel: 'semantic-ui' }, next: 'second' },
      { kind: 'observe', id: 'second', request: futureRequest },
    ],
  };

  const runtime = new ComputerTaskRuntime(program, registry(first, intended, hijacker), { executionId: EXECUTION_ID });
  const pending = runtime.run();
  await observing;

  let getterReads = 0;
  Object.defineProperty(futureRequest, 'adapterId', {
    configurable: true,
    enumerable: true,
    get() {
      getterReads += 1;
      return hijacker.descriptor.id;
    },
  });
  futureRequest.limits.maxItems = 1000;
  release();

  const result = await pending;
  assert.equal(result.status, 'completed');
  assert.equal(getterReads, 0);
  assert.equal(intended.observations.length, 1);
  assert.equal(hijacker.observations.length, 0);
  assert.equal(intended.observations[0]?.limits?.maxItems, 3);
});
