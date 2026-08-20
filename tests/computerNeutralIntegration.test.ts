import assert from 'node:assert/strict';
import test from 'node:test';

import {
  COMPUTER_EFFECT_CLASSES,
  COMPUTER_ENTITY_KINDS,
  COMPUTER_ENVIRONMENT_KINDS,
  COMPUTER_OBSERVATION_CHANNELS,
  computerActionMayAutoRetry,
  computerEffectRequiresApproval,
  validateComputerActionRequest,
  validateComputerEntityRef,
  validateComputerObservationRequest,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEnvironmentAdapter,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
} from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';

test('neutral contract exposes the additive adapter integration union', () => {
  for (const kind of ['local-compute'] as const) assert.ok(COMPUTER_ENVIRONMENT_KINDS.includes(kind));
  for (const channel of ['compute', 'system'] as const) assert.ok(COMPUTER_OBSERVATION_CHANNELS.includes(channel));
  for (const kind of [
    'peripheral',
    'volume',
    'system-setting-scope',
    'security-setting-scope',
    'compute-job',
    'artifact',
  ] as const) assert.ok(COMPUTER_ENTITY_KINDS.includes(kind));
  assert.ok(COMPUTER_EFFECT_CLASSES.includes('process-execution'));
});

test('neutral validation accepts local-compute and desktop system observations', () => {
  assert.deepEqual(validateComputerObservationRequest({
    adapterId: 'compute:test',
    channel: 'compute',
    limits: { maxItems: 1, maxTextBytes: 128, maxDepth: 1 },
  }, {
    id: 'compute:test',
    kind: 'local-compute',
    version: '1.0.0',
    capabilities: ['local-compute.run'],
  }), []);

  assert.deepEqual(validateComputerObservationRequest({
    adapterId: 'desktop:test',
    channel: 'system',
    limits: { maxItems: 1, maxTextBytes: 128, maxDepth: 1 },
  }, {
    id: 'desktop:test',
    kind: 'desktop-ui',
    version: '1.0.0',
    capabilities: ['desktop.system.observe'],
  }), []);
});

test('neutral entity validation accepts integration entity identities', () => {
  const entities = [
    { adapterId: 'device:test', environment: 'device' as const, kind: 'peripheral' as const, entityId: 'peripheral:1', generation: 1 },
    { adapterId: 'device:test', environment: 'device' as const, kind: 'volume' as const, entityId: 'volume:1', generation: 1 },
    { adapterId: 'device:test', environment: 'device' as const, kind: 'system-setting-scope' as const, entityId: 'setting:system', generation: 1 },
    { adapterId: 'device:test', environment: 'device' as const, kind: 'security-setting-scope' as const, entityId: 'setting:security', generation: 1 },
    { adapterId: 'compute:test', environment: 'local-compute' as const, kind: 'compute-job' as const, entityId: 'job:1', generation: 1 },
    { adapterId: 'compute:test', environment: 'local-compute' as const, kind: 'artifact' as const, entityId: 'artifact:1', generation: 1 },
  ];
  for (const entity of entities) assert.deepEqual(validateComputerEntityRef(entity), []);
});

test('process-execution keeps approval and conservative retry semantics', () => {
  const request: ComputerActionRequest = {
    adapterId: 'process:test',
    actionId: 'run-1',
    capability: 'terminal.execute.argv',
    effect: 'process-execution',
    idempotency: 'non-idempotent',
  };
  assert.deepEqual(validateComputerActionRequest(request, {
    id: 'process:test',
    kind: 'process',
    version: '1.0.0',
    capabilities: ['terminal.execute.argv'],
  }), []);
  assert.equal(computerEffectRequiresApproval('process-execution'), true);
  assert.equal(computerActionMayAutoRetry(request, { dispatch: 'not-dispatched' }), true);
  assert.equal(computerActionMayAutoRetry(request, { dispatch: 'unknown' }), false);
  assert.equal(computerActionMayAutoRetry(request, { dispatch: 'dispatched-once' }), false);
});

class LocalComputeFixture implements ComputerEnvironmentAdapter {
  readonly descriptor = Object.freeze({
    id: 'compute:test',
    kind: 'local-compute' as const,
    version: '1.0.0',
    capabilities: Object.freeze(['local-compute.run']),
  });

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    return {
      adapterId: this.descriptor.id,
      environment: this.descriptor.kind,
      channel: request.channel,
      sequence: 1,
      complete: true,
      truncated: false,
      data: Object.freeze({ jobs: Object.freeze([]) }),
    };
  }

  async act(_request: ComputerActionRequest): Promise<ComputerActionResult> {
    return {
      status: 'completed',
      dispatch: 'not-dispatched',
      verification: 'verified',
      evidence: ['compute-read-verified'],
    };
  }
}

test('registry routes the new local-compute environment without special cases', async () => {
  const registry = new ComputerEnvironmentRegistry();
  registry.register(new LocalComputeFixture());

  const observed = await registry.observe({
    adapterId: 'compute:test',
    channel: 'compute',
    limits: { maxItems: 1, maxTextBytes: 128, maxDepth: 1 },
  });
  assert.equal(observed.environment, 'local-compute');
  assert.equal(observed.channel, 'compute');

  const result = await registry.act({
    adapterId: 'compute:test',
    actionId: 'read-job',
    capability: 'local-compute.run',
    effect: 'observe-only',
    idempotency: 'read-only',
  });
  assert.deepEqual(result, {
    status: 'completed',
    dispatch: 'not-dispatched',
    verification: 'verified',
    evidence: ['compute-read-verified'],
  });
});
