import { SecureBootLinuxSystemDeviceBackend } from './secureBootLinuxSystemDeviceBackend.js';
import { TruthfulLinuxSystemDeviceBackend } from './truthfulLinuxSystemDeviceBackend.js';
import type { LinuxSystemDeviceBackendOptions } from './linuxSystemDeviceBackend.js';
import type { BoundedDeviceMetadata, BoundedVolumeMetadata, SystemDeviceBackendResult, SystemDeviceEnumerationBudget } from './systemDeviceAdapter.js';

/** Preserve Secure Boot posture while using fail-closed production enumeration. */
export class SecureBootTruthfulLinuxSystemDeviceBackend extends SecureBootLinuxSystemDeviceBackend {
  private readonly truthfulEnumeration: TruthfulLinuxSystemDeviceBackend;

  constructor(options: LinuxSystemDeviceBackendOptions = {}) {
    super(options);
    this.truthfulEnumeration = new TruthfulLinuxSystemDeviceBackend(options);
  }

  override enumerateDevices(
    budget: Readonly<SystemDeviceEnumerationBudget>,
  ): Promise<SystemDeviceBackendResult<readonly BoundedDeviceMetadata[]>> {
    return this.truthfulEnumeration.enumerateDevices(budget);
  }

  override enumerateVolumes(
    budget: Readonly<SystemDeviceEnumerationBudget>,
  ): Promise<SystemDeviceBackendResult<readonly BoundedVolumeMetadata[]>> {
    return this.truthfulEnumeration.enumerateVolumes(budget);
  }
}
