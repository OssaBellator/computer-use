import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SystemDeviceEnvironmentAdapter,
  type BoundedSystemInformation,
  type SecuritySettingObservation,
  type SecuritySettingScopeIdentity,
  type SystemDeviceBackend,
  type SystemDeviceBackendResult,
  type SystemDeviceIdentity,
  type SystemDeviceMutationBaseline,
  type SystemDeviceMutationDispatch,
  type SystemDeviceMutationPayload,
  type SystemDeviceMutationVerification,
  type SystemSettingObservation,
  type SystemSettingScopeIdentity,
} from '../src/computer/systemDeviceAdapter.js';

const systemScope: SystemSettingScopeIdentity = {
  id: 'scope:system:test', kind: 'system-setting-scope', generation: 1,
};
const securityScope: SecuritySettingScopeIdentity = {
  id: 'scope:security:test', kind: 'security-setting-scope', generation: 1,
};
const target: SystemDeviceIdentity<'peripheral'> = {
  id: 'peripheral:test', kind: 'peripheral', generation: 1,
};

class TinyBudgetBackend implements SystemDeviceBackend {
  readonly platformFamily = 'synthetic';
  async privilegeState() { return { state: 'available' as const }; }
  async systemInformation(): Promise<SystemDeviceBackendResult<BoundedSystemInformation>> {
    return { state: 'ok', value: { platformFamily: 'synthetic', architecture: 'test-arch' } };
  }
  async enumerateDevices() { return { state: 'ok' as const, value: [] }; }
  async enumerateVolumes() { return { state: 'ok' as const, value: [] }; }
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
    return { state: 'ok', value: { target, configurationRevision: 'rev-1' } };
  }
  async dispatchMutation(_payload: SystemDeviceMutationPayload): Promise<SystemDeviceMutationDispatch> {
    return { state: 'dispatched', verificationToken: 'dispatch-1' };
  }
  async verifyMutation(): Promise<SystemDeviceMutationVerification> {
    return { state: 'verified', evidence: ['post-state-match'] };
  }
}

test('tiny maxTextBytes omits optional system text instead of emitting an unbudgeted fallback', async () => {
  const adapter = new SystemDeviceEnvironmentAdapter('system-device-test', new TinyBudgetBackend());
  const result = await adapter.observe({
    adapterId: 'system-device-test',
    channel: 'device',
    limits: { maxItems: 1, maxTextBytes: 1 },
  });

  const snapshot = result.data as { system?: BoundedSystemInformation };
  assert.equal(snapshot.system, undefined);
  assert.equal(result.truncated, true);
  assert.doesNotMatch(JSON.stringify(result.data), /"platformFamily":"unknown"/);
});
