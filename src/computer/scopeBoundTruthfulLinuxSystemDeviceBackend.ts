import { ScopeBoundLinuxSystemDeviceBackend } from './scopeBoundLinuxSystemDeviceBackend.js';
import { TruthfulLinuxSystemDeviceBackend } from './truthfulLinuxSystemDeviceBackend.js';
import type { LinuxSystemDeviceBackendOptions } from './linuxSystemDeviceBackend.js';
import type {
  BoundedDeviceMetadata,
  BoundedVolumeMetadata,
  SystemDeviceBackendResult,
  SystemDeviceEnumerationBudget,
} from './systemDeviceAdapter.js';

/** Compose setting-scope authority with the fail-closed production enumeration boundary. */
export class ScopeBoundTruthfulLinuxSystemDeviceBackend extends ScopeBoundLinuxSystemDeviceBackend {
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
