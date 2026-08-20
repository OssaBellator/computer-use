import { KernelVisibilityLinuxSystemDeviceBackend } from './kernelVisibilityLinuxSystemDeviceBackend.js';
import { TruthfulLinuxSystemDeviceBackend } from './truthfulLinuxSystemDeviceBackend.js';
import type { LinuxSystemDeviceBackendOptions } from './linuxSystemDeviceBackend.js';
import type { BoundedDeviceMetadata, BoundedVolumeMetadata, SystemDeviceBackendResult, SystemDeviceEnumerationBudget } from './systemDeviceAdapter.js';

/** Preserve kernel visibility posture while using fail-closed production enumeration. */
export class KernelVisibilityTruthfulLinuxSystemDeviceBackend extends KernelVisibilityLinuxSystemDeviceBackend {
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
