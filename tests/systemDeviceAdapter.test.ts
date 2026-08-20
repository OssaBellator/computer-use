import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerActionRequest, ComputerObservationRequest } from '../src/computer/environmentAdapter.js';
import {
  SystemDeviceEnvironmentAdapter,
  type BoundedDeviceMetadata,
  type BoundedSystemInformation,
  type BoundedVolumeMetadata,
  type SecuritySettingObservation,
  type SecuritySettingScopeIdentity,
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

const systemScope: SystemSettingScopeIdentity = { id: 'scope:system:display', kind: 'system-setting-scope', generation: 1 };
const securityScope: SecuritySettingScopeIdentity = { id: 'scope:security:host', kind: 'security-setting-scope', generation: 1 };
const peripheral: SystemDeviceIdentity<'peripheral'> = { id: 'peripheral:keyboard-primary', kind: 'peripheral', generation: 1 };

class FakeSystemDeviceBackend implements SystemDeviceBackend {
  readonly platformFamily = 'synthetic';
  access: SystemDevicePrivilegeState = { state: 'available' };
  devices: BoundedDeviceMetadata[] = [
    {
      identity: { id: 'device:display-main', kind: 'device', generation: 1 },
      category: 'display',
      presence: 'present',
      state: 'ready',
      label: 'Synthetic display',
    },
    {
      identity: peripheral,
      category: 'input',
      presence: 'present',
      state: 'ready',
      label: 'Synthetic keyboard',
    },
  ];
  volumes: BoundedVolumeMetadata[] = [
    {
      identity: { id: 'volume:system', kind: 'volume', generation: 3 },
      state: 'online',
      removable: false,
      capacityBytes: 1_000_000,
      freeBytes: 400_000,
      filesystemType: 'syntheticfs',
    },
  ];
  system: BoundedSystemInformation = {
    platformFamily: 'synthetic',
    architecture: 'test-arch',
    logicalProcessorCount: 4,
    totalMemoryBytes: 8_000_000,
  };
  systemSetting: SystemSettingObservation = {
    scope: systemScope,
    setting: 'display.scale',
    state: 'known',
    value: 125,
    revision: 'rev-system-1',
  };
  securitySetting: SecuritySettingObservation = {
    scope: securityScope,
    setting: 'host.protection',
    state: 'known',
    value: 'managed',
    revision: 'rev-security-1',
  };
  currentBaseline: SystemDeviceMutationBaseline = {
    target: peripheral,
    configurationRevision: 'rev-peripheral-1',
  };
  dispatchCount = 0;
  throwOnDispatch = false;
  verification: SystemDeviceMutationVerification = { state: 'verified', evidence: ['post-state-match'] };

  async privilegeState(): Promise<SystemDevicePrivilegeState> {
    return this.access;
  }

  async systemInformation(): Promise<SystemDeviceBackendResult<BoundedSystemInformation>> {
    return this.access.state === 'available'
      ? { state: 'ok', value: this.system }
      : { state: this.access.state, evidence: this.access.reason ?? this.access.state } as SystemDeviceBackendResult<BoundedSystemInformation>;
  }

  async enumerateDevices(): Promise<SystemDeviceBackendResult<readonly BoundedDeviceMetadata[]>> {
    return this.access.state === 'available'
      ? { state: 'ok', value: this.devices }
      : { state: this.access.state, evidence: this.access.reason ?? this.access.state } as SystemDeviceBackendResult<readonly BoundedDeviceMetadata[]>;
  }

  async enumerateVolumes(): Promise<SystemDeviceBackendResult<readonly BoundedVolumeMetadata[]>> {
    return this.access.state === 'available'
      ? { state: 'ok', value: this.volumes }
      : { state: this.access.state, evidence: this.access.reason ?? this.access.state } as SystemDeviceBackendResult<readonly BoundedVolumeMetadata[]>;
  }

  async observeSystemSetting(scope: SystemSettingScopeIdentity, setting: string): Promise<SystemDeviceBackendResult<SystemSettingObservation>> {
    if (this.access.state !== 'available') {
      return { state: this.access.state, evidence: this.access.reason ?? this.access.state } as SystemDeviceBackendResult<SystemSettingObservation>;
    }
    return { state: 'ok', value: { ...this.systemSetting, scope, setting } };
  }

  async observeSecuritySetting(scope: SecuritySettingScopeIdentity, setting: string): Promise<SystemDeviceBackendResult<SecuritySettingObservation>> {
    if (this.access.state !== 'available') {
      return { state: this.access.state, evidence: this.access.reason ?? this.access.state } as SystemDeviceBackendResult<SecuritySettingObservation>;
    }
    return { state: 'ok', value: { ...this.securitySetting, scope, setting } };
  }

  async freshMutationBaseline(): Promise<SystemDeviceBackendResult<SystemDeviceMutationBaseline>> {
    if (this.access.state !== 'available') {
      return { state: this.access.state, evidence: this.access.reason ?? this.access.state } as SystemDeviceBackendResult<SystemDeviceMutationBaseline>;
    }
    return { state: 'ok', value: this.currentBaseline };
  }

  async dispatchMutation(): Promise<SystemDeviceMutationDispatch> {
    this.dispatchCount += 1;
    if (this.throwOnDispatch) throw new Error('synthetic uncertain dispatch');
    return { state: 'dispatched', verificationToken: `dispatch:${this.dispatchCount}` };
  }

  async verifyMutation(): Promise<SystemDeviceMutationVerification> {
    return this.verification;
  }
}

function observationRequest(maxItems = 64): ComputerObservationRequest {
  return { adapterId: 'system-device-test', channel: 'device', limits: { maxItems } };
}

function mutationRequest(
  actionId: string,
  payload: SystemDeviceMutationPayload,
  effect: ComputerActionRequest['effect'] = 'hardware-affecting',
): ComputerActionRequest {
  return {
    adapterId: 'system-device-test',
    actionId,
    capability: 'device.peripheral.configure',
    effect,
    idempotency: 'non-idempotent',
    payload,
  };
}

function approvedPeripheralPayload(target: SystemDeviceIdentity = peripheral): SystemDeviceMutationPayload {
  return {
    operation: 'peripheral-configuration',
    target,
    setting: 'input.repeat-rate',
    value: 30,
    approval: {
      approved: true,
      approvalId: 'approval:synthetic:1',
      effect: 'hardware-affecting',
      target,
      configurationRevision: 'rev-peripheral-1',
    },
  };
}

test('device enumeration returns bounded non-sensitive metadata and system volumes', async () => {
  const backend = new FakeSystemDeviceBackend();
  (backend.devices[0] as BoundedDeviceMetadata & Record<string, unknown>).serialNumber = 'SERIAL-DO-NOT-EXPOSE';
  (backend.devices[0] as BoundedDeviceMetadata & Record<string, unknown>).securityToken = 'TOKEN-DO-NOT-EXPOSE';
  (backend.volumes[0] as BoundedVolumeMetadata & Record<string, unknown>).nativeGuid = 'FULL-GUID-DO-NOT-EXPOSE';
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend);

  const result = await adapter.observe(observationRequest());
  assert.equal(result.environment, 'device');
  assert.equal(result.complete, true);
  const snapshot = result.data as {
    system: BoundedSystemInformation;
    devices: Array<Record<string, unknown>>;
    volumes: Array<Record<string, unknown>>;
  };
  assert.equal(snapshot.system.platformFamily, 'synthetic');
  assert.equal(snapshot.devices.length, 2);
  assert.equal(snapshot.volumes.length, 1);
  assert.equal(snapshot.devices[0].serialNumber, undefined);
  assert.equal(snapshot.devices[0].securityToken, undefined);
  assert.equal(snapshot.volumes[0].nativeGuid, undefined);
  assert.doesNotMatch(JSON.stringify(result.data), /SERIAL-DO-NOT-EXPOSE|TOKEN-DO-NOT-EXPOSE|FULL-GUID-DO-NOT-EXPOSE/);
});

test('enumeration limits are enforced and reported as truncated', async () => {
  const backend = new FakeSystemDeviceBackend();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend);
  const result = await adapter.observe(observationRequest(1));
  const snapshot = result.data as { devices: readonly BoundedDeviceMetadata[]; volumes: readonly BoundedVolumeMetadata[] };
  assert.equal(snapshot.devices.length, 1);
  assert.equal(snapshot.volumes.length, 1);
  assert.equal(result.truncated, true);
});

test('device replacement advances generation and stale identities are rejected before dispatch', async () => {
  const backend = new FakeSystemDeviceBackend();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, { enableMutations: true });
  const before = await adapter.observe(observationRequest());
  const first = (before.data as { devices: readonly BoundedDeviceMetadata[] }).devices[1].identity;

  const replacement: SystemDeviceIdentity<'peripheral'> = { ...peripheral, generation: 2 };
  backend.devices[1] = { ...backend.devices[1], identity: replacement };
  backend.currentBaseline = { target: replacement, configurationRevision: 'rev-peripheral-2' };
  const after = await adapter.observe(observationRequest());
  const second = (after.data as { devices: readonly BoundedDeviceMetadata[] }).devices[1].identity;
  assert.equal(first.id, second.id);
  assert.equal(first.generation, 1);
  assert.equal(second.generation, 2);

  const result = await adapter.act(mutationRequest('stale-action', approvedPeripheralPayload(first)));
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.deepEqual(result.evidence, ['stale-identity-or-baseline']);
  assert.equal(backend.dispatchCount, 0);
});

test('system-setting observation is scope and revision aware', async () => {
  const backend = new FakeSystemDeviceBackend();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend);
  const result = await adapter.observeSystemSetting(systemScope, 'display.scale');
  assert.equal(result.state, 'ok');
  if (result.state === 'ok') {
    assert.deepEqual(result.value.scope, systemScope);
    assert.equal(result.value.value, 125);
    assert.equal(result.value.revision, 'rev-system-1');
  }
});

test('security-setting observation is deliberately coarse', async () => {
  const backend = new FakeSystemDeviceBackend();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend);
  const result = await adapter.observeSecuritySetting(securityScope, 'host.protection');
  assert.equal(result.state, 'ok');
  if (result.state === 'ok') {
    assert.equal(result.value.value, 'managed');
    assert.equal(result.value.revision, 'rev-security-1');
    assert.equal('rules' in result.value, false);
    assert.equal('token' in result.value, false);
  }
});

test('unsupported privilege and permission denied states are explicit', async () => {
  const backend = new FakeSystemDeviceBackend();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, { enableMutations: true });

  backend.access = { state: 'unsupported-privilege', reason: 'elevation-unavailable' };
  const observation = await adapter.observe(observationRequest());
  assert.equal(observation.complete, false);
  assert.deepEqual((observation.data as { access: SystemDevicePrivilegeState }).access, backend.access);

  backend.access = { state: 'permission-denied', reason: 'policy-denied' };
  const setting = await adapter.observeSecuritySetting(securityScope, 'host.protection');
  assert.deepEqual(setting, { state: 'permission-denied', evidence: 'policy-denied' });
  const mutation = await adapter.act(mutationRequest('denied-action', approvedPeripheralPayload()));
  assert.equal(mutation.status, 'unsupported');
  assert.equal(mutation.dispatch, 'not-dispatched');
  assert.deepEqual(mutation.evidence, ['policy-denied']);
});

test('mutation capability is opt-in and exact risk classification is required', async () => {
  const backend = new FakeSystemDeviceBackend();
  const observationOnly = new SystemDeviceEnvironmentAdapter('system-device-test', backend);
  assert.equal(observationOnly.descriptor.capabilities.includes('device.peripheral.configure'), false);
  const disabled = await observationOnly.act(mutationRequest('disabled-action', approvedPeripheralPayload()));
  assert.deepEqual(disabled.evidence, ['mutation-disabled']);
  assert.equal(disabled.dispatch, 'not-dispatched');

  const enabled = new SystemDeviceEnvironmentAdapter('system-device-test', backend, { enableMutations: true });
  const wrongRisk = await enabled.act(mutationRequest('wrong-risk', approvedPeripheralPayload(), 'local-reversible'));
  assert.equal(wrongRisk.status, 'rejected');
  assert.deepEqual(wrongRisk.evidence, ['risk-classification-mismatch']);
  assert.equal(backend.dispatchCount, 0);
});

test('fresh configuration revision must match the approved baseline', async () => {
  const backend = new FakeSystemDeviceBackend();
  backend.currentBaseline = { target: peripheral, configurationRevision: 'rev-peripheral-changed' };
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, { enableMutations: true });
  const result = await adapter.act(mutationRequest('stale-config', approvedPeripheralPayload()));
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.deepEqual(result.evidence, ['stale-identity-or-baseline']);
  assert.equal(backend.dispatchCount, 0);
});

test('uncertain configuration dispatch is never auto-retried and actionId is single-use', async () => {
  const backend = new FakeSystemDeviceBackend();
  backend.throwOnDispatch = true;
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, { enableMutations: true });
  const request = mutationRequest('uncertain-action', approvedPeripheralPayload());

  const first = await adapter.act(request);
  assert.equal(first.status, 'unknown');
  assert.equal(first.dispatch, 'unknown');
  assert.equal(adapter.mayAutoRetry(request, first), false);
  assert.equal(backend.dispatchCount, 1);

  backend.throwOnDispatch = false;
  const second = await adapter.act(request);
  assert.equal(second.status, 'rejected');
  assert.deepEqual(second.evidence, ['action-id-already-used']);
  assert.equal(backend.dispatchCount, 1);
});

test('successful synthetic mutation dispatches exactly once and verifies post-state', async () => {
  const backend = new FakeSystemDeviceBackend();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, { enableMutations: true });
  const result = await adapter.act(mutationRequest('verified-action', approvedPeripheralPayload()));
  assert.equal(result.status, 'completed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(result.verification, 'verified');
  assert.deepEqual(result.evidence, ['post-state-match']);
  assert.equal(backend.dispatchCount, 1);
});

test('evidence is restricted to bounded machine codes and does not leak backend secrets', async () => {
  const backend = new FakeSystemDeviceBackend();
  backend.verification = {
    state: 'verified',
    evidence: ['token=super-secret-value', '-----BEGIN PRIVATE KEY-----'],
  };
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, { enableMutations: true });
  const result = await adapter.act(mutationRequest('privacy-action', approvedPeripheralPayload()));
  assert.deepEqual(result.evidence, ['evidence-redacted']);
  assert.doesNotMatch(JSON.stringify(result), /super-secret|PRIVATE KEY/);
});

test('dangerous generic high-risk operations remain unsupported', async () => {
  const backend = new FakeSystemDeviceBackend();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, { enableMutations: true });
  for (const capability of [
    'device.disk.partition',
    'device.storage.destructive',
    'device.firmware.flash',
    'security.firewall.modify',
    'security.antivirus.modify',
    'security.account.privileged.modify',
  ]) {
    const result = await adapter.act({
      adapterId: 'system-device-test',
      actionId: `unsupported:${capability}`,
      capability,
      effect: capability.startsWith('device.firmware') ? 'hardware-affecting' : 'security-sensitive',
      idempotency: 'non-idempotent',
      payload: approvedPeripheralPayload(),
    });
    assert.equal(result.status, 'unsupported', capability);
    assert.equal(result.dispatch, 'not-dispatched', capability);
    assert.deepEqual(result.evidence, ['high-risk-operation-unsupported'], capability);
  }
  assert.equal(backend.dispatchCount, 0);
});
