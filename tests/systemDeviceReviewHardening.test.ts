import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerActionRequest, ComputerActionResult, ComputerObservationRequest } from '../src/computer/environmentAdapter.js';
import {
  SystemDeviceEnvironmentAdapter,
  type BoundedDeviceMetadata,
  type BoundedSystemInformation,
  type BoundedVolumeMetadata,
  type SecuritySettingObservation,
  type SecuritySettingScopeIdentity,
  type SystemDeviceActionLedger,
  type SystemDeviceApprovalVerifier,
  type SystemDeviceBackend,
  type SystemDeviceBackendResult,
  type SystemDeviceIdentity,
  type SystemDeviceMutationBaseline,
  type SystemDeviceMutationDispatch,
  type SystemDeviceMutationPayload,
  type SystemDeviceMutationVerification,
  type SystemDevicePrivilegeState,
  type SystemSettingObservation,
  type SystemSettingScopeIdentity,
} from '../src/computer/systemDeviceAdapter.js';

const target: SystemDeviceIdentity<'peripheral'> = {
  id: 'peripheral:review-test', kind: 'peripheral', generation: 1,
};
const systemScope: SystemSettingScopeIdentity = {
  id: 'scope:system:review-test', kind: 'system-setting-scope', generation: 1,
};
const securityScope: SecuritySettingScopeIdentity = {
  id: 'scope:security:review-test', kind: 'security-setting-scope', generation: 1,
};

class ReviewBackend implements SystemDeviceBackend {
  readonly platformFamily = 'synthetic';
  observationCalls = 0;
  dispatches: SystemDeviceMutationPayload[] = [];

  async privilegeState(): Promise<SystemDevicePrivilegeState> {
    this.observationCalls += 1;
    return { state: 'available' };
  }
  async systemInformation(): Promise<SystemDeviceBackendResult<BoundedSystemInformation>> {
    this.observationCalls += 1;
    return { state: 'ok', value: { platformFamily: 'synthetic' } };
  }
  async enumerateDevices(): Promise<SystemDeviceBackendResult<readonly BoundedDeviceMetadata[]>> {
    this.observationCalls += 1;
    return { state: 'ok', value: [] };
  }
  async enumerateVolumes(): Promise<SystemDeviceBackendResult<readonly BoundedVolumeMetadata[]>> {
    this.observationCalls += 1;
    return { state: 'ok', value: [] };
  }
  async observeSystemSetting(
    scope: SystemSettingScopeIdentity,
    setting: string,
  ): Promise<SystemDeviceBackendResult<SystemSettingObservation>> {
    return { state: 'ok', value: { scope, setting, state: 'known', value: true, revision: 'rev-1' } };
  }
  async observeSecuritySetting(
    scope: SecuritySettingScopeIdentity,
    setting: string,
  ): Promise<SystemDeviceBackendResult<SecuritySettingObservation>> {
    return { state: 'ok', value: { scope, setting, state: 'known', value: 'enabled', revision: 'rev-1' } };
  }
  async freshMutationBaseline(
    mutationTarget: SystemDeviceIdentity,
    setting: string,
  ): Promise<SystemDeviceBackendResult<SystemDeviceMutationBaseline>> {
    assert.deepEqual(mutationTarget, target);
    assert.equal(setting, 'input.repeat-rate');
    return { state: 'ok', value: { target, configurationRevision: 'rev-1' } };
  }
  async dispatchMutation(payload: SystemDeviceMutationPayload): Promise<SystemDeviceMutationDispatch> {
    this.dispatches.push(payload);
    return { state: 'dispatched', verificationToken: 'dispatch-review-1' };
  }
  async verifyMutation(): Promise<SystemDeviceMutationVerification> {
    return { state: 'verified', evidence: ['post-state-match'] };
  }
}

class ReviewLedger implements SystemDeviceActionLedger {
  claims: string[] = [];
  async claim(actionId: string): Promise<'claimed'> {
    this.claims.push(actionId);
    return 'claimed';
  }
  async record(_actionId: string, _result: Readonly<ComputerActionResult>): Promise<void> {}
}

function mutablePayload(): SystemDeviceMutationPayload {
  return {
    operation: 'peripheral-configuration',
    target: { ...target },
    setting: 'input.repeat-rate',
    value: 30,
    approval: {
      approved: true,
      approvalId: 'approval:review-trusted',
      effect: 'hardware-affecting',
      target: { ...target },
      configurationRevision: 'rev-1',
    },
  };
}

test('invalid direct observation limits fail closed before backend work', async () => {
  const invalidLimits: ComputerObservationRequest['limits'][] = [
    { maxItems: -1 },
    { maxItems: 0 },
    { maxItems: Number.NaN },
    { maxTextBytes: -1 },
    { maxTextBytes: 0 },
    { maxTextBytes: Number.NaN },
  ];

  for (const limits of invalidLimits) {
    const backend = new ReviewBackend();
    const adapter = new SystemDeviceEnvironmentAdapter('system-device-review', backend);
    const result = await adapter.observe({
      adapterId: 'system-device-review',
      channel: 'device',
      limits,
    });
    assert.equal(result.complete, false);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.data, {
      access: { state: 'unsupported-platform', reason: 'invalid-observation-request' },
    });
    assert.equal(backend.observationCalls, 0);
  }
});

test('caller mutation during approval cannot change approved or dispatched material', async () => {
  const backend = new ReviewBackend();
  const ledger = new ReviewLedger();
  const payload = mutablePayload();
  const request: ComputerActionRequest = {
    adapterId: 'system-device-review',
    actionId: 'action:original',
    capability: 'device.peripheral.configure',
    effect: 'hardware-affecting',
    idempotency: 'non-idempotent',
    payload,
  };

  const verifier: SystemDeviceApprovalVerifier = {
    async verify(_approvedRequest, approvedPayload) {
      assert.equal(approvedPayload.setting, 'input.repeat-rate');
      assert.equal(approvedPayload.value, 30);
      assert.equal(approvedPayload.target.generation, 1);

      // Simulate a caller retaining and mutating its original objects while the
      // trusted approval await is in flight.
      payload.setting = 'input.attacker-setting';
      payload.value = 999;
      payload.operation = 'system-setting-change';
      payload.target.generation = 99;
      payload.approval.configurationRevision = 'attacker-revision';
      request.actionId = 'action:attacker';
      request.capability = 'system.setting.change';
      request.effect = 'system-configuration';
      return true;
    },
  };

  const adapter = new SystemDeviceEnvironmentAdapter('system-device-review', backend, {
    enableMutations: true,
    approvalVerifier: verifier,
    actionLedger: ledger,
  });
  const result = await adapter.act(request);

  assert.equal(result.status, 'completed');
  assert.deepEqual(ledger.claims, ['action:original']);
  assert.equal(backend.dispatches.length, 1);
  const dispatched = backend.dispatches[0];
  assert.equal(dispatched.operation, 'peripheral-configuration');
  assert.equal(dispatched.setting, 'input.repeat-rate');
  assert.equal(dispatched.value, 30);
  assert.equal(dispatched.target.generation, 1);
  assert.equal(dispatched.approval.configurationRevision, 'rev-1');
  assert.equal(Object.isFrozen(dispatched), true);
  assert.equal(Object.isFrozen(dispatched.target), true);
  assert.equal(Object.isFrozen(dispatched.approval), true);
});
