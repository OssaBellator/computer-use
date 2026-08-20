import { platform } from 'node:os';
import { type LinuxSystemDeviceBackendOptions } from './linuxSystemDeviceBackend.js';
import { ScopeBoundTruthfulLinuxSystemDeviceBackend } from './scopeBoundTruthfulLinuxSystemDeviceBackend.js';
import {
  SystemDeviceEnvironmentAdapter,
  type BoundedDeviceMetadata,
  type BoundedSystemInformation,
  type BoundedVolumeMetadata,
  type SecuritySettingObservation,
  type SecuritySettingScopeIdentity,
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
} from './systemDeviceAdapter.js';

/**
 * Explicit fail-closed boundary for operating systems without a reviewed native backend.
 * It exists so host selection never implies that an untested backend is production-ready.
 */
export class UnsupportedHostSystemDeviceBackend implements SystemDeviceBackend {
  readonly platformFamily: string;
  readonly mutationSupport = 'none' as const;

  constructor(platformFamily: string) {
    this.platformFamily = platformFamily;
  }

  private failure<T>(): SystemDeviceBackendResult<T> {
    return Object.freeze({ state: 'unsupported-platform' as const, evidence: 'host-platform-backend-unsupported' });
  }

  async privilegeState(): Promise<SystemDevicePrivilegeState> {
    return Object.freeze({ state: 'unsupported-platform', reason: 'host-platform-backend-unsupported' });
  }

  async systemInformation(): Promise<SystemDeviceBackendResult<BoundedSystemInformation>> {
    return this.failure();
  }

  async enumerateDevices(
    _budget: Readonly<SystemDeviceEnumerationBudget>,
  ): Promise<SystemDeviceBackendResult<readonly BoundedDeviceMetadata[]>> {
    return this.failure();
  }

  async enumerateVolumes(
    _budget: Readonly<SystemDeviceEnumerationBudget>,
  ): Promise<SystemDeviceBackendResult<readonly BoundedVolumeMetadata[]>> {
    return this.failure();
  }

  async observeSystemSetting(
    _scope: SystemSettingScopeIdentity,
    _setting: string,
  ): Promise<SystemDeviceBackendResult<SystemSettingObservation>> {
    return this.failure();
  }

  async observeSecuritySetting(
    _scope: SecuritySettingScopeIdentity,
    _setting: string,
  ): Promise<SystemDeviceBackendResult<SecuritySettingObservation>> {
    return this.failure();
  }

  async freshMutationBaseline(
    _target: SystemDeviceIdentity,
    _setting: string,
  ): Promise<SystemDeviceBackendResult<SystemDeviceMutationBaseline>> {
    return Object.freeze({ state: 'unsupported-privilege' as const, evidence: 'read-only-backend' });
  }

  async dispatchMutation(
    _payload: SystemDeviceMutationPayload,
    _baseline: SystemDeviceMutationBaseline,
  ): Promise<SystemDeviceMutationDispatch> {
    throw new Error('read-only-backend');
  }

  async verifyMutation(
    _payload: SystemDeviceMutationPayload,
    _baseline: SystemDeviceMutationBaseline,
    _dispatch: SystemDeviceMutationDispatch,
  ): Promise<SystemDeviceMutationVerification> {
    return Object.freeze({ state: 'unverified', evidence: Object.freeze(['read-only-backend']) });
  }
}

export interface HostSystemDeviceBackendOptions {
  readonly platformFamily?: NodeJS.Platform;
  readonly linux?: Omit<LinuxSystemDeviceBackendOptions, 'platformFamily'>;
}

/** Select only a reviewed host backend. Linux is currently the sole real implementation. */
export function createHostSystemDeviceBackend(options: HostSystemDeviceBackendOptions = {}): SystemDeviceBackend {
  const hostPlatform = options.platformFamily ?? platform();
  if (hostPlatform === 'linux') {
    return new ScopeBoundTruthfulLinuxSystemDeviceBackend({ ...options.linux, platformFamily: 'linux' });
  }
  return new UnsupportedHostSystemDeviceBackend(hostPlatform);
}

/** Production host adapter factory. Intentionally exposes no mutation enablement options. */
export function createHostSystemDeviceEnvironmentAdapter(
  adapterId: string,
  options: HostSystemDeviceBackendOptions = {},
): SystemDeviceEnvironmentAdapter {
  return new SystemDeviceEnvironmentAdapter(adapterId, createHostSystemDeviceBackend(options));
}
