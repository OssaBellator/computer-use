import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerActionRequest, ComputerActionResult, ComputerObservationRequest } from '../src/computer/environmentAdapter.js';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
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

const systemScope: SystemSettingScopeIdentity = { id: 'scope:system:display', kind: 'system-setting-scope', generation: 1 };
const securityScope: SecuritySettingScopeIdentity = { id: 'scope:security:host', kind: 'security-setting-scope', generation: 1 };
const peripheral: SystemDeviceIdentity<'peripheral'> = { id: 'peripheral:keyboard-primary', kind: 'peripheral', generation: 1 };

class FakeSystemDeviceBackend implements SystemDeviceBackend {
  readonly platformFamily = 'synthetic';
  access: SystemDevicePrivilegeState = { state: 'available' };
  devices: BoundedDeviceMetadata[] = [
    {
      identity: { id: 'device:display-main', kind: 'device', generation: 1 },
      category: 'display', presence: 'present', state: 'ready', label: 'Synthetic display',
    },
    {
      identity: peripheral, category: 'input', presence: 'present', state: 'ready', label: 'Synthetic keyboard',
    },
  ];
  volumes: BoundedVolumeMetadata[] = [{
    identity: { id: 'volume:system', kind: 'volume', generation: 3 },
    state: 'online', removable: false, capacityBytes: 1_000_000, freeBytes: 400_000, filesystemType: 'syntheticfs',
  }];
  system: BoundedSystemInformation = {
    platformFamily: 'synthetic', architecture: 'test-arch', logicalProcessorCount: 4, totalMemoryBytes: 8_000_000,
  };
  systemSetting: SystemSettingObservation = {
    scope: systemScope, setting: 'display.scale', state: 'known', value: 125, revision: 'rev-system-1',
  };
  securitySetting: SecuritySettingObservation = {
    scope: securityScope, setting: 'host.protection', state: 'known', value: 'managed', revision: 'rev-security-1',
  };
  currentBaseline: SystemDeviceMutationBaseline = { target: peripheral, configurationRevision: 'rev-peripheral-1' };
  dispatchCount = 0;
  throwOnDispatch = false;
  verification: SystemDeviceMutationVerification = { state: 'verified', evidence: ['post-state-match'] };

  async privilegeState(): Promise<SystemDevicePrivilegeState> { return this.access; }
  async systemInformation(): Promise<SystemDeviceBackendResult<BoundedSystemInformation>> {
    return this.access.state === 'available' ? { state: 'ok', value: this.system } :
      { state: this.access.state, evidence: this.access.reason ?? this.access.state } as SystemDeviceBackendResult<BoundedSystemInformation>;
  }
  async enumerateDevices(): Promise<SystemDeviceBackendResult<readonly BoundedDeviceMetadata[]>> {
    return this.access.state === 'available' ? { state: 'ok', value: this.devices } :
      { state: this.access.state, evidence: this.access.reason ?? this.access.state } as SystemDeviceBackendResult<readonly BoundedDeviceMetadata[]>;
  }
  async enumerateVolumes(): Promise<SystemDeviceBackendResult<readonly BoundedVolumeMetadata[]>> {
    return this.access.state === 'available' ? { state: 'ok', value: this.volumes } :
      { state: this.access.state, evidence: this.access.reason ?? this.access.state } as SystemDeviceBackendResult<readonly BoundedVolumeMetadata[]>;
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
    return this.access.state === 'available' ? { state: 'ok', value: this.currentBaseline } :
      { state: this.access.state, evidence: this.access.reason ?? this.access.state } as SystemDeviceBackendResult<SystemDeviceMutationBaseline>;
  }
  async dispatchMutation(): Promise<SystemDeviceMutationDispatch> {
    this.dispatchCount += 1;
    if (this.throwOnDispatch) throw new Error('synthetic uncertain dispatch');
    return { state: 'dispatched', verificationToken: `dispatch:${this.dispatchCount}` };
  }
  async verifyMutation(): Promise<SystemDeviceMutationVerification> { return this.verification; }
}

class FakeApprovalVerifier implements SystemDeviceApprovalVerifier {
  trustedIds = new Set(['approval:synthetic:1']);
  async verify(_: Readonly<Pick<ComputerActionRequest, 'actionId' | 'capability' | 'effect'>>, payload: Readonly<SystemDeviceMutationPayload>): Promise<boolean> {
    return this.trustedIds.has(payload.approval.approvalId);
  }
}

class FakeActionLedger implements SystemDeviceActionLedger {
  readonly claims = new Set<string>();
  readonly results = new Map<string, Readonly<ComputerActionResult>>();
  async claim(actionId: string): Promise<'claimed' | 'already-used'> {
    if (this.claims.has(actionId)) return 'already-used';
    this.claims.add(actionId);
    return 'claimed';
  }
  async record(actionId: string, result: Readonly<ComputerActionResult>): Promise<void> {
    this.results.set(actionId, result);
  }
}

function mutationOptions(verifier = new FakeApprovalVerifier(), ledger = new FakeActionLedger()) {
  return { enableMutations: true, approvalVerifier: verifier, actionLedger: ledger };
}
function observationRequest(maxItems = 64, maxTextBytes = 16_384): ComputerObservationRequest {
  return { adapterId: 'system-device-test', channel: 'device', limits: { maxItems, maxTextBytes } };
}
function mutationRequest(
  actionId: string,
  payload: SystemDeviceMutationPayload,
  effect: ComputerActionRequest['effect'] = 'hardware-affecting',
): ComputerActionRequest {
  return {
    adapterId: 'system-device-test', actionId, capability: 'device.peripheral.configure',
    effect, idempotency: 'non-idempotent', payload,
  };
}
function approvedPeripheralPayload(target: SystemDeviceIdentity = peripheral, approvalId = 'approval:synthetic:1'): SystemDeviceMutationPayload {
  return {
    operation: 'peripheral-configuration', target, setting: 'input.repeat-rate', value: 30,
    approval: {
      approved: true, approvalId, effect: 'hardware-affecting', target, configurationRevision: 'rev-peripheral-1',
    },
  };
}

test('device enumeration rebuilds bounded non-sensitive metadata and system volumes', async () => {
  const backend = new FakeSystemDeviceBackend();
  (backend.devices[0] as BoundedDeviceMetadata & Record<string, unknown>).serialNumber = 'SERIAL-DO-NOT-EXPOSE';
  (backend.devices[0] as BoundedDeviceMetadata & Record<string, unknown>).securityToken = 'TOKEN-DO-NOT-EXPOSE';
  (backend.volumes[0] as BoundedVolumeMetadata & Record<string, unknown>).nativeGuid = 'FULL-GUID-DO-NOT-EXPOSE';
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend);
  const result = await adapter.observe(observationRequest());
  const snapshot = result.data as {
    system: BoundedSystemInformation;
    devices: Array<Record<string, unknown>>;
    volumes: Array<Record<string, unknown>>;
  };
  assert.equal(result.complete, true);
  assert.equal(snapshot.system.platformFamily, 'synthetic');
  assert.equal(snapshot.devices.length, 2);
  assert.equal(snapshot.volumes.length, 1);
  assert.equal(snapshot.devices[0].serialNumber, undefined);
  assert.equal(snapshot.devices[0].securityToken, undefined);
  assert.equal(snapshot.volumes[0].nativeGuid, undefined);
  assert.doesNotMatch(JSON.stringify(result.data), /SERIAL-DO-NOT-EXPOSE|TOKEN-DO-NOT-EXPOSE|FULL-GUID-DO-NOT-EXPOSE/);
});

test('maxItems is shared across devices and volumes and truncation is deterministic', async () => {
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', new FakeSystemDeviceBackend());
  const result = await adapter.observe(observationRequest(1));
  const snapshot = result.data as { devices: readonly BoundedDeviceMetadata[]; volumes: readonly BoundedVolumeMetadata[] };
  assert.equal(snapshot.devices.length + snapshot.volumes.length, 1);
  assert.equal(snapshot.devices.length, 1);
  assert.equal(snapshot.volumes.length, 0);
  assert.equal(result.truncated, true);
});

test('maxTextBytes is honored across observation text fields', async () => {
  const backend = new FakeSystemDeviceBackend();
  backend.devices[0].label = '1234567890';
  backend.devices[1].label = 'abcdefghij';
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend);
  const result = await adapter.observe(observationRequest(64, 12));
  const snapshot = result.data as {
    access: SystemDevicePrivilegeState;
    system?: BoundedSystemInformation;
    devices: readonly BoundedDeviceMetadata[];
    volumes: readonly BoundedVolumeMetadata[];
  };
  const texts = [
    snapshot.access.reason, snapshot.system?.platformFamily, snapshot.system?.architecture,
    ...snapshot.devices.map((d) => d.label), ...snapshot.volumes.map((v) => v.filesystemType),
  ].filter((v): v is string => v !== undefined);
  const bytes = texts.reduce((sum, value) => sum + new TextEncoder().encode(value).byteLength, 0);
  assert.ok(bytes <= 12);
  assert.equal(result.truncated, true);
});

test('device replacement advances generation and stale identities are rejected before dispatch', async () => {
  const backend = new FakeSystemDeviceBackend();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, mutationOptions());
  const before = await adapter.observe(observationRequest());
  const first = (before.data as { devices: readonly BoundedDeviceMetadata[] }).devices[1].identity;
  const replacement: SystemDeviceIdentity<'peripheral'> = { ...peripheral, generation: 2 };
  backend.devices[1] = { ...backend.devices[1], identity: replacement };
  backend.currentBaseline = { target: replacement, configurationRevision: 'rev-peripheral-2' };
  const after = await adapter.observe(observationRequest());
  const second = (after.data as { devices: readonly BoundedDeviceMetadata[] }).devices[1].identity;
  assert.equal(first.id, second.id);
  assert.equal(second.generation, 2);
  const result = await adapter.act(mutationRequest('stale-action', approvedPeripheralPayload(first)));
  assert.deepEqual(result.evidence, ['stale-identity-or-baseline']);
  assert.equal(result.dispatch, 'not-dispatched');
  assert.equal(backend.dispatchCount, 0);
});

test('system-setting observation rebuilds and bounds backend values', async () => {
  const backend = new FakeSystemDeviceBackend();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend);
  const good = await adapter.observeSystemSetting(systemScope, 'display.scale');
  assert.equal(good.state, 'ok');
  if (good.state === 'ok') assert.equal(good.value.value, 125);

  backend.systemSetting = { ...backend.systemSetting, value: 'x'.repeat(300) };
  const bad = await adapter.observeSystemSetting(systemScope, 'display.scale');
  assert.deepEqual(bad, { state: 'unsupported-platform', evidence: 'invalid-backend-observation' });
});

test('security-setting observation is coarse and rejects backend value expansion', async () => {
  const backend = new FakeSystemDeviceBackend();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend);
  const good = await adapter.observeSecuritySetting(securityScope, 'host.protection');
  assert.equal(good.state, 'ok');
  if (good.state === 'ok') assert.equal(good.value.value, 'managed');

  (backend.securitySetting as unknown as { value: string }).value = 'raw-ruleset';
  const bad = await adapter.observeSecuritySetting(securityScope, 'host.protection');
  assert.deepEqual(bad, { state: 'unsupported-platform', evidence: 'invalid-backend-observation' });
});

test('privilege reasons and backend failure evidence are sanitized', async () => {
  const backend = new FakeSystemDeviceBackend();
  backend.access = { state: 'unsupported-privilege', reason: 'user=secret-admin\nTOKEN' };
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend);
  const observation = await adapter.observe(observationRequest());
  assert.equal(observation.complete, false);
  assert.deepEqual(
    (observation.data as { access: SystemDevicePrivilegeState }).access,
    { state: 'unsupported-privilege', reason: 'backend-access-unavailable' },
  );
  assert.doesNotMatch(JSON.stringify(observation), /secret-admin|TOKEN/);
});

test('neutral registry advertises only observations routable through ComputerEnvironmentAdapter', async () => {
  const registry = new ComputerEnvironmentRegistry();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', new FakeSystemDeviceBackend());
  registry.register(adapter);
  const descriptor = registry.descriptor('system-device-test');
  assert.ok(descriptor);
  assert.equal(descriptor?.capabilities.includes('device.observe'), true);
  assert.equal(descriptor?.capabilities.includes('system.observe'), true);
  assert.equal(descriptor?.capabilities.includes('system.setting.observe'), false);
  assert.equal(descriptor?.capabilities.includes('security.setting.observe'), false);
  const observed = await registry.observe(observationRequest());
  assert.equal(observed.channel, 'device');
  assert.equal(observed.complete, true);
});

test('mutation is disabled unless trusted verifier and action ledger are injected', async () => {
  const backend = new FakeSystemDeviceBackend();
  const optionCases = [
    { enableMutations: true },
    { enableMutations: true, approvalVerifier: new FakeApprovalVerifier() },
    { enableMutations: true, actionLedger: new FakeActionLedger() },
  ];
  for (let i = 0; i < optionCases.length; i += 1) {
    const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, optionCases[i]);
    assert.equal(adapter.descriptor.capabilities.includes('device.peripheral.configure'), false);
    const result = await adapter.act(mutationRequest(`disabled-${i}`, approvedPeripheralPayload()));
    assert.deepEqual(result.evidence, ['mutation-disabled']);
  }
  assert.equal(backend.dispatchCount, 0);
});

test('forged caller approval is rejected by trusted verifier before dispatch', async () => {
  const backend = new FakeSystemDeviceBackend();
  const verifier = new FakeApprovalVerifier();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, mutationOptions(verifier));
  const forged = approvedPeripheralPayload(peripheral, 'approval:forged-by-caller');
  const result = await adapter.act(mutationRequest('forged-approval', forged));
  assert.equal(result.status, 'rejected');
  assert.equal(result.dispatch, 'not-dispatched');
  assert.deepEqual(result.evidence, ['approval-not-trusted']);
  assert.equal(backend.dispatchCount, 0);
});

test('exact risk classification and fresh configuration baseline are required', async () => {
  const backend = new FakeSystemDeviceBackend();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, mutationOptions());
  const wrongRisk = await adapter.act(mutationRequest('wrong-risk', approvedPeripheralPayload(), 'local-reversible'));
  assert.deepEqual(wrongRisk.evidence, ['risk-classification-mismatch']);
  backend.currentBaseline = { target: peripheral, configurationRevision: 'rev-peripheral-changed' };
  const stale = await adapter.act(mutationRequest('stale-config', approvedPeripheralPayload()));
  assert.deepEqual(stale.evidence, ['stale-identity-or-baseline']);
  assert.equal(backend.dispatchCount, 0);
});

test('uncertain dispatch remains claimed in external ledger and cannot redispatch', async () => {
  const backend = new FakeSystemDeviceBackend();
  backend.throwOnDispatch = true;
  const ledger = new FakeActionLedger();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, mutationOptions(new FakeApprovalVerifier(), ledger));
  const request = mutationRequest('uncertain-action', approvedPeripheralPayload());

  const first = await adapter.act(request);
  assert.equal(first.dispatch, 'unknown');
  assert.equal(adapter.mayAutoRetry(request, first), false);
  assert.equal(backend.dispatchCount, 1);
  assert.equal(ledger.claims.has('uncertain-action'), true);

  backend.throwOnDispatch = false;
  const second = await adapter.act(request);
  assert.equal(second.status, 'rejected');
  assert.equal(second.dispatch, 'unknown');
  assert.deepEqual(second.evidence, ['action-id-already-used']);
  assert.equal(backend.dispatchCount, 1);
});

test('successful synthetic mutation dispatches exactly once and verifies post-state', async () => {
  const backend = new FakeSystemDeviceBackend();
  const ledger = new FakeActionLedger();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, mutationOptions(new FakeApprovalVerifier(), ledger));
  const result = await adapter.act(mutationRequest('verified-action', approvedPeripheralPayload()));
  assert.equal(result.status, 'completed');
  assert.equal(result.dispatch, 'dispatched-once');
  assert.equal(result.verification, 'verified');
  assert.deepEqual(result.evidence, ['post-state-match']);
  assert.equal(backend.dispatchCount, 1);
  assert.equal(ledger.results.get('verified-action')?.status, 'completed');
});

test('evidence is restricted to bounded machine codes and does not leak backend secrets', async () => {
  const backend = new FakeSystemDeviceBackend();
  backend.verification = { state: 'verified', evidence: ['token=super-secret-value', '-----BEGIN PRIVATE KEY-----'] };
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, mutationOptions());
  const result = await adapter.act(mutationRequest('privacy-action', approvedPeripheralPayload()));
  assert.deepEqual(result.evidence, ['evidence-redacted']);
  assert.doesNotMatch(JSON.stringify(result), /super-secret|PRIVATE KEY/);
});

test('dangerous generic high-risk operations remain unsupported', async () => {
  const backend = new FakeSystemDeviceBackend();
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', backend, mutationOptions());
  for (const capability of [
    'device.disk.partition',
    'device.storage.destructive',
    'device.firmware.flash',
    'security.firewall.modify',
    'security.antivirus.modify',
    'security.account.privileged.modify',
  ]) {
    const result = await adapter.act({
      adapterId: 'system-device-test', actionId: `unsupported:${capability}`, capability,
      effect: capability.startsWith('device.firmware') ? 'hardware-affecting' : 'security-sensitive',
      idempotency: 'non-idempotent', payload: approvedPeripheralPayload(),
    });
    assert.equal(result.status, 'unsupported', capability);
    assert.equal(result.dispatch, 'not-dispatched', capability);
    assert.deepEqual(result.evidence, ['high-risk-operation-unsupported'], capability);
  }
  assert.equal(backend.dispatchCount, 0);
});
