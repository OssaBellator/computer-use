import { arch, availableParallelism, platform, totalmem } from 'node:os';
import { TruthfulInventoryLinuxSystemDeviceBackend } from './truthfulInventoryLinuxSystemDeviceBackend.js';
import type { LinuxSystemDeviceBackendOptions } from './linuxSystemDeviceBackend.js';
import type {
  BoundedSystemInformation,
  SystemDeviceBackendResult,
} from './systemDeviceAdapter.js';

/**
 * Host-information specialization that acquires only the scalar processor count
 * needed by the neutral schema. It deliberately avoids `os.cpus()`, which would
 * materialize per-CPU model/speed/timing records that are never exposed.
 */
export class MinimalSystemInfoLinuxSystemDeviceBackend extends TruthfulInventoryLinuxSystemDeviceBackend {
  private readonly systemInfoPlatform: NodeJS.Platform;

  constructor(options: LinuxSystemDeviceBackendOptions = {}) {
    super(options);
    this.systemInfoPlatform = options.platformFamily ?? platform();
  }

  override async systemInformation(): Promise<SystemDeviceBackendResult<BoundedSystemInformation>> {
    if (this.systemInfoPlatform !== 'linux') {
      return { state: 'unsupported-platform', evidence: 'linux-backend-on-non-linux' };
    }
    const logicalProcessorCount = availableParallelism();
    const totalMemoryBytes = totalmem();
    return {
      state: 'ok',
      value: Object.freeze({
        platformFamily: 'linux',
        architecture: arch(),
        ...(Number.isSafeInteger(logicalProcessorCount) && logicalProcessorCount >= 0
          ? { logicalProcessorCount }
          : {}),
        ...(Number.isSafeInteger(totalMemoryBytes) && totalMemoryBytes >= 0
          ? { totalMemoryBytes }
          : {}),
      }),
    };
  }
}
