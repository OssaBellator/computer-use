import assert from 'node:assert/strict';
import test from 'node:test';

import type {
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEnvironmentAdapter,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { ComputerTaskRuntime } from '../src/computer/computerTaskRuntime.js';

const EXECUTION_ID = '66666666666666666666666666666666';

class Adapter implements ComputerEnvironmentAdapter {
  readonly descriptor;
  actions = 0;
  observations = 0;

  constructor(
    id: string,
    kind: 'browser' | 'local-compute',
    capabilities: readonly string[],
    private readonly actionResult?: ComputerActionResult,
    private readonly observationData: unknown = null,
  ) {
    this.descriptor = Object.freeze({ id, kind, version: 'evidence-boundary-1', capabilities: Object.freeze([...capabilities]) });
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
      data: this.observationData,
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    this.actions += 1;
    return this.actionResult ?? {
      status: 'completed',
      dispatch: 'not-dispatched',
      verification: 'verified',
      evidence: ['synthetic-ok'],
    };
  }
}

function registry(...adapters: ComputerEnvironmentAdapter[]): ComputerEnvironmentRegistry {
  const value = new ComputerEnvironmentRegistry();
  for (const adapter of adapters) value.register(adapter);
  return value;
}

function observeThenAction(browserId: string, computeId: string, verification?: string): ComputerTaskProgram {
  return {
    id: `evidence-boundary-${verification ?? 'adapter'}`,
    entry: 'observe',
    steps: [
      {
        kind: 'observe',
        id: 'observe',
        request: { adapterId: browserId, channel: 'semantic-ui' },
        next: 'compute',
      },
      {
        kind: 'action',
        id: 'compute',
        request: {
          adapterId: computeId,
          actionId: 'compute',
          capability: 'fixture.compute',
          effect: 'observe-only',
          idempotency: 'read-only',
        },
        verification,
      },
    ],
  };
}

test('invalid adapter evidence is replaced by a bounded machine code without leaking private text', async () => {
  const secret = 'PRIVATE ADAPTER EVIDENCE MUST NOT LEAK';
  const browser = new Adapter('browser:evidence-invalid', 'browser', ['browser.observe'], undefined, { secret: 'PRIVATE OBSERVATION' });
  const compute = new Adapter('compute:evidence-invalid', 'local-compute', ['fixture.compute'], {
    status: 'completed',
    dispatch: 'not-dispatched',
    verification: 'verified',
    evidence: [secret],
    details: { secret: 'PRIVATE ACTION DETAILS' },
  });

  const result = await new ComputerTaskRuntime(
    observeThenAction(browser.descriptor.id, compute.descriptor.id),
    registry(browser, compute),
    { executionId: EXECUTION_ID },
  ).run();

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.evidence, ['adapter-evidence-invalid']);
  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes(secret), false);
  assert.equal(serialized.includes('PRIVATE OBSERVATION'), false);
  assert.equal(serialized.includes('PRIVATE ACTION DETAILS'), false);
});

test('oversized adapter evidence is collapsed before crossing into runtime evidence', async () => {
  const browser = new Adapter('browser:evidence-oversized', 'browser', ['browser.observe']);
  const compute = new Adapter('compute:evidence-oversized', 'local-compute', ['fixture.compute'], {
    status: 'completed',
    dispatch: 'not-dispatched',
    verification: 'verified',
    evidence: Array.from({ length: 33 }, (_, index) => `code-${index}`),
  });

  const result = await new ComputerTaskRuntime(
    observeThenAction(browser.descriptor.id, compute.descriptor.id),
    registry(browser, compute),
    { executionId: EXECUTION_ID },
  ).run();

  assert.equal(result.status, 'completed');
  assert.deepEqual(result.evidence, ['adapter-evidence-invalid']);
  assert.equal(result.evidence?.length, 1);
});

test('invalid verifier evidence is normalized without exposing verifier-private text', async () => {
  const browser = new Adapter('browser:verifier-evidence', 'browser', ['browser.observe']);
  const compute = new Adapter('compute:verifier-evidence', 'local-compute', ['fixture.compute'], {
    status: 'completed',
    dispatch: 'not-dispatched',
    verification: 'verified',
    evidence: ['adapter-ok'],
  });
  const secret = 'PRIVATE VERIFIER EVIDENCE';

  const result = await new ComputerTaskRuntime(
    observeThenAction(browser.descriptor.id, compute.descriptor.id, 'fixture.verify'),
    registry(browser, compute),
    {
      executionId: EXECUTION_ID,
      hooks: {
        verifiers: {
          'fixture.verify': async () => ({ state: 'verified', evidence: ['verifier-ok', secret] }),
        },
      },
    },
  ).run();

  assert.equal(result.status, 'completed');
  assert.ok(result.evidence?.includes('adapter-ok'));
  assert.ok(result.evidence?.includes('verifier-ok'));
  assert.ok(result.evidence?.includes('runtime-evidence-invalid'));
  assert.equal(JSON.stringify(result).includes(secret), false);
});

test('private adapter details may be inspected by the verifier but are never copied to the task result', async () => {
  const browser = new Adapter('browser:private-details', 'browser', ['browser.observe']);
  const privateMarker = 'PRIVATE-DIRECT-DETAIL';
  const compute = new Adapter('compute:private-details', 'local-compute', ['fixture.compute'], {
    status: 'completed',
    dispatch: 'not-dispatched',
    verification: 'verified',
    evidence: ['adapter-ok'],
    details: { marker: privateMarker },
  });
  let verifierSawMarker = false;

  const result = await new ComputerTaskRuntime(
    observeThenAction(browser.descriptor.id, compute.descriptor.id, 'fixture.details.verify'),
    registry(browser, compute),
    {
      executionId: EXECUTION_ID,
      hooks: {
        verifiers: {
          'fixture.details.verify': async ({ adapterResult }) => {
            verifierSawMarker = (adapterResult.details as { marker?: string } | undefined)?.marker === privateMarker;
            return { state: 'verified', evidence: ['details-checked'] };
          },
        },
      },
    },
  ).run();

  assert.equal(result.status, 'completed');
  assert.equal(verifierSawMarker, true);
  assert.equal(JSON.stringify(result).includes(privateMarker), false);
  assert.ok(result.evidence?.includes('details-checked'));
});
