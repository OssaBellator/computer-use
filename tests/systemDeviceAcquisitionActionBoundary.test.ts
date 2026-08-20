import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerActionRequest, ComputerActionResult } from '../src/computer/environmentAdapter.js';
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
  type SystemDeviceEnumerationBudget,
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
  id: 'peripheral:bounded-review', kind: 'peripheral', generation: 1,
};

class BoundaryBackend implements SystemDeviceBackend {
  readonly platformFamily = 'synthetic';
  observationCalls = 0;
  mutationCalls = 0;
  deviceBudget?: Readonly<SystemDeviceEnumerationBudget>;
  volumeBudget?: Readonly<SystemDeviceEnumerationBudget>;
  materializedDevices = 0;
  materializedVolumes = 0;
  violateDeviceBudget = false;

  async privilegeState(): Promise<SystemDevicePrivilegeState> {
    this.observationCalls += 1;
    return { state: 'available' };
  }
  async systemInformation(): Promise<SystemDeviceBackendResult<BoundedSystemInformation>> {
    this.observationCalls += 1;
    return { state: 'ok', value: { platformFamily: 'synthetic' } };
  }
  async enumerateDevices(budget: Readonly<SystemDeviceEnumerationBudget>): Promise<SystemDeviceBackendResult<readonly BoundedDeviceMetadata[]>> {
    this.observationCalls += 1;
    this.deviceBudget = budget;
    const count = this.violateDeviceBudget ? budget.maxItems + 1 : budget.maxItems;
    this.materializedDevices += count;
    return {
      state: 'ok',
      value: Array.from({ length: count }, (_, index) => ({
        identity: { id: `device:${index}`, kind: 'device' as const, generation: 1 },
        category: 'input' as const,
        presence: 'present' as const,
        state: 'ready' as const,
        label: `device-${index}`,
      })),
    };
  }
  async enumerateVolumes(budget: Readonly<SystemDeviceEnumerationBudget>): Promise<SystemDeviceBackendResult<readonly BoundedVolumeMetadata[]>> {
    this.observationCalls += 1;
    this.volumeBudget = budget;
    this.materializedVolumes += budget.maxItems;
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
  async freshMutationBaseline(): Promise<SystemDeviceBackendResult<SystemDeviceMutationBaseline>> {
    this.mutationCalls += 1;
    return { state: 'ok', value: { target, configurationRevision: 'rev-1' } };
  }
  async dispatchMutation(): Promise<SystemDeviceMutationDispatch> {
    this.mutationCalls += 1;
    return { state: 'dispatched', verificationToken: 'dispatch-1' };
  }
  async verifyMutation(): Promise<SystemDeviceMutationVerification> {
    this.mutationCalls += 1;
    return { state: 'verified', evidence: ['post-state-match'] };
  }
}

class BoundaryLedger implements SystemDeviceActionLedger {
  claims: string[] = [];
  async claim(actionId: string): Promise<'claimed'> {
    this.claims.push(actionId);
    return 'claimed';
  }
  async record(_actionId: string, _result: Readonly<ComputerActionResult>): Promise<void> {}
}

function payload(): SystemDeviceMutationPayload {
  return {
    operation: 'peripheral-configuration',
    target: { ...target },
    setting: 'input.repeat-rate',
    value: 30,
    approval: {
      approved: true,
      approvalId: 'approval:bounded-review',
      effect: 'hardware-affecting',
      target: { ...target },
      configurationRevision: 'rev-1',
    },
  };
}

test('tiny observation limit is pushed into acquisition and does not materialize a large inventory', async () => {
  const backend = new BoundaryBackend();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-boundary', backend);

  const result = await adapter.observe({
    adapterId: 'system-device-boundary',
    channel: 'device',
    limits: { maxItems: 1, maxTextBytes: 128 },
  });

  assert.deepEqual(backend.deviceBudget, { maxItems: 1, maxTextBytes: 128 });
  assert.equal(backend.materializedDevices, 1);
  assert.equal(backend.materializedVolumes, 0);
  assert.equal(backend.volumeBudget, undefined);
  const data = result.data as { devices: readonly unknown[]; volumes: readonly unknown[] };
  assert.equal(data.devices.length, 1);
  assert.equal(data.volumes.length, 0);
  assert.equal(result.truncated, true);
});

test('backend enumeration that exceeds its acquisition budget fails closed before iteration', async () => {
  const backend = new BoundaryBackend();
  backend.violateDeviceBudget = true;
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-boundary', backend);

  const result = await adapter.observe({
    adapterId: 'system-device-boundary',
    channel: 'device',
    limits: { maxItems: 1, maxTextBytes: 128 },
  });

  assert.equal(result.complete, false);
  assert.equal(result.truncated, true);
  assert.equal(backend.volumeBudget, undefined);
  assert.deepEqual(result.data, {
    access: { state: 'unsupported-platform', reason: 'invalid-backend-observation' },
    devices: [],
    volumes: [],
  });
});

test('invalid direct action envelope fails closed before approval ledger or backend work', async () => {
  const invalidRequests: ComputerActionRequest[] = [
    {
      adapterId: 'system-device-boundary',
      actionId: 'action:bad-idempotency',
      capability: 'device.peripheral.configure',
      effect: 'hardware-affecting',
      idempotency: 'sometimes' as ComputerActionRequest['idempotency'],
      payload: payload(),
    },
    {
      adapterId: 'system-device-boundary',
      actionId: 'x'.repeat(300),
      capability: 'device.peripheral.configure',
      effect: 'hardware-affecting',
      idempotency: 'non-idempotent',
      payload: payload(),
    },
  ];

  for (const request of invalidRequests) {
    const backend = new BoundaryBackend();
    const ledger = new BoundaryLedger();
    let verifierCalls = 0;
    const verifier: SystemDeviceApprovalVerifier = {
      async verify() {
        verifierCalls += 1;
        return true;
      },
    };
    const adapter = new SystemDeviceEnvironmentAdapter('system-device-boundary', backend, {
      enableMutations: true,
      approvalVerifier: verifier,
      actionLedger: ledger,
    });

    const result = await adapter.act(request);
    assert.equal(result.status, 'rejected');
    assert.equal(result.dispatch, 'not-dispatched');
    assert.deepEqual(result.evidence, ['invalid-action-request']);
    assert.equal(verifierCalls, 0);
    assert.deepEqual(ledger.claims, []);
    assert.equal(backend.mutationCalls, 0);
  }
});
