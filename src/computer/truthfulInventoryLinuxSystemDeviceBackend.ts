import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, opendir, statfs } from 'node:fs/promises';
import { platform } from 'node:os';
import { KernelVisibilityLinuxSystemDeviceBackend } from './kernelVisibilityLinuxSystemDeviceBackend.js';
import type { LinuxSystemDeviceBackendOptions } from './linuxSystemDeviceBackend.js';
import {
  SystemDeviceEnvironmentAdapter,
  type BoundedDeviceMetadata,
  type BoundedVolumeMetadata,
  type DeviceIdentity,
  type SystemDeviceBackendResult,
  type SystemDeviceEnumerationBudget,
  type SystemDeviceIdentity,
  type SystemDeviceIdentityKind,
  type SystemVolumeIdentity,
} from './systemDeviceAdapter.js';
import type { ComputerObservationEnvelope, ComputerObservationRequest } from './environmentAdapter.js';

const SAFE_FILESYSTEM_TYPE = /^[a-zA-Z0-9._+-]{1,64}$/u;
const VIRTUAL_FILESYSTEMS = new Set([
  'proc', 'sysfs', 'devpts', 'cgroup', 'cgroup2', 'mqueue', 'tracefs', 'securityfs',
  'debugfs', 'pstore', 'configfs', 'fusectl', 'hugetlbfs', 'ramfs',
]);
const DEVICE_CLASSES: readonly Readonly<{
  directory: string;
  category: BoundedDeviceMetadata['category'];
  kind: DeviceIdentity['kind'];
}>[] = Object.freeze([
  Object.freeze({ directory: 'drm', category: 'display', kind: 'device' }),
  Object.freeze({ directory: 'input', category: 'input', kind: 'peripheral' }),
  Object.freeze({ directory: 'sound', category: 'audio', kind: 'peripheral' }),
  Object.freeze({ directory: 'video4linux', category: 'camera', kind: 'peripheral' }),
  Object.freeze({ directory: 'block', category: 'storage', kind: 'device' }),
  Object.freeze({ directory: 'net', category: 'network', kind: 'device' }),
]);

interface IdentityRecord {
  readonly id: string;
  generation: number;
  fingerprint: string;
}

class InventoryIdentityStore {
  private readonly records = new Map<string, IdentityRecord>();

  resolve<K extends SystemDeviceIdentityKind>(kind: K, locator: string, fingerprint: string): SystemDeviceIdentity<K> {
    const key = `${kind}\0${locator}`;
    let record = this.records.get(key);
    if (!record) {
      record = { id: `linux-inventory-${randomBytes(16).toString('hex')}`, generation: 1, fingerprint };
      this.records.set(key, record);
    } else if (record.fingerprint !== fingerprint) {
      record.generation = Math.min(Number.MAX_SAFE_INTEGER, record.generation + 1);
      record.fingerprint = fingerprint;
    }
    return Object.freeze({ id: record.id, kind, generation: record.generation });
  }
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function fingerprint(parts: readonly (string | number | bigint)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(String(part)).update('\0');
  return hash.digest('hex').slice(0, 24);
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function count(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function finiteNonNegative(value: number): number | undefined {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Production Linux inventory backend that records whether acquisition itself was
 * complete under the caller-supplied item/text budget. The returned schemas remain
 * the existing SystemDeviceBackend arrays; completeness is consumed by the paired
 * host adapter below rather than widening the neutral backend contract.
 */
export class TruthfulInventoryLinuxSystemDeviceBackend extends KernelVisibilityLinuxSystemDeviceBackend {
  private readonly inventoryIdentities = new InventoryIdentityStore();
  private readonly inventorySysClassRoot: string;
  private readonly inventoryProcRoot: string;
  private readonly inventoryPlatform: NodeJS.Platform;
  private deviceComplete = true;
  private volumeComplete = true;

  constructor(options: LinuxSystemDeviceBackendOptions = {}) {
    super(options);
    this.inventorySysClassRoot = options.sysClassRoot ?? '/sys/class';
    this.inventoryProcRoot = options.procRoot ?? '/proc';
    this.inventoryPlatform = options.platformFamily ?? platform();
  }

  beginObservation(): void {
    this.deviceComplete = true;
    this.volumeComplete = true;
  }

  acquisitionComplete(): boolean {
    return this.deviceComplete && this.volumeComplete;
  }

  override async enumerateDevices(
    budget: Readonly<SystemDeviceEnumerationBudget>,
  ): Promise<SystemDeviceBackendResult<readonly BoundedDeviceMetadata[]>> {
    if (this.inventoryPlatform !== 'linux') {
      return { state: 'unsupported-platform', evidence: 'linux-backend-on-non-linux' };
    }
    const maxItems = count(budget.maxItems);
    let textRemaining = count(budget.maxTextBytes);
    if (maxItems === 0 || textRemaining === 0) {
      this.deviceComplete = false;
      return { state: 'ok', value: Object.freeze([]) };
    }

    const items: BoundedDeviceMetadata[] = [];
    let permissionFailure = false;
    outer: for (const source of DEVICE_CLASSES) {
      let directory;
      try {
        directory = await opendir(`${this.inventorySysClassRoot}/${source.directory}`);
      } catch (error) {
        const code = errorCode(error);
        if (code === 'EACCES' || code === 'EPERM') {
          permissionFailure = true;
          this.deviceComplete = false;
        }
        continue;
      }
      try {
        for await (const entry of directory) {
          if (items.length >= maxItems) {
            this.deviceComplete = false;
            break outer;
          }
          const nameBytes = utf8Bytes(entry.name);
          if (nameBytes > textRemaining) {
            this.deviceComplete = false;
            break outer;
          }
          textRemaining -= nameBytes;
          const nativePath = `${this.inventorySysClassRoot}/${source.directory}/${entry.name}`;
          try {
            const metadata = await lstat(nativePath);
            const nativeFingerprint = fingerprint([
              metadata.dev, metadata.ino, metadata.size, Math.floor(metadata.ctimeMs), source.directory,
            ]);
            const identity = this.inventoryIdentities.resolve(source.kind, nativePath, nativeFingerprint) as DeviceIdentity;
            items.push(Object.freeze({ identity, category: source.category, presence: 'present', state: 'ready' }));
          } catch (error) {
            const code = errorCode(error);
            if (code === 'EACCES' || code === 'EPERM') permissionFailure = true;
            this.deviceComplete = false;
          }
        }
      } finally {
        try { await directory.close(); } catch { /* iterator can close the handle */ }
      }
    }

    if (items.length === 0 && permissionFailure) {
      return { state: 'permission-denied', evidence: 'device-enumeration-permission-denied' };
    }
    return { state: 'ok', value: Object.freeze(items) };
  }

  override async enumerateVolumes(
    budget: Readonly<SystemDeviceEnumerationBudget>,
  ): Promise<SystemDeviceBackendResult<readonly BoundedVolumeMetadata[]>> {
    if (this.inventoryPlatform !== 'linux') {
      return { state: 'unsupported-platform', evidence: 'linux-backend-on-non-linux' };
    }
    const maxItems = count(budget.maxItems);
    const maxTextBytes = count(budget.maxTextBytes);
    if (maxItems === 0 || maxTextBytes === 0) {
      this.volumeComplete = false;
      return { state: 'ok', value: Object.freeze([]) };
    }

    let handle;
    let raw: Buffer;
    try {
      handle = await open(`${this.inventoryProcRoot}/self/mountinfo`, 'r');
      const buffer = Buffer.alloc(maxTextBytes);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      raw = buffer.subarray(0, bytesRead);
      if (bytesRead === maxTextBytes) this.volumeComplete = false;
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EACCES' || code === 'EPERM') return { state: 'permission-denied', evidence: 'host-permission-denied' };
      if (code === 'ENOSYS' || code === 'ENOTSUP') return { state: 'unsupported-platform', evidence: 'host-feature-unsupported' };
      return { state: 'unsupported-privilege', evidence: 'host-observation-unavailable' };
    } finally {
      try { await handle?.close(); } catch { /* best effort close */ }
    }

    const text = raw.toString('utf8');
    const parseable = this.volumeComplete || text.endsWith('\n')
      ? text
      : text.slice(0, Math.max(0, text.lastIndexOf('\n') + 1));
    const items: BoundedVolumeMetadata[] = [];
    for (const line of parseable.split('\n')) {
      if (!line) continue;
      if (items.length >= maxItems) {
        this.volumeComplete = false;
        break;
      }
      const separator = line.indexOf(' - ');
      if (separator < 0) continue;
      const left = line.slice(0, separator).split(' ');
      const right = line.slice(separator + 3).split(' ');
      if (left.length < 6 || right.length < 2) continue;
      const filesystemType = right[0] ?? '';
      if (!SAFE_FILESYSTEM_TYPE.test(filesystemType) || VIRTUAL_FILESYSTEMS.has(filesystemType)) continue;
      const mountPoint = decodeMountInfoPath(left[4] ?? '');
      if (!mountPoint.startsWith('/')) continue;
      try {
        const filesystem = await statfs(mountPoint);
        const identity = this.inventoryIdentities.resolve(
          'volume', mountPoint, fingerprint([left[0] ?? '', left[2] ?? '', filesystemType]),
        ) as SystemVolumeIdentity;
        const capacityBytes = finiteNonNegative(filesystem.blocks * filesystem.bsize);
        const freeBytes = finiteNonNegative(filesystem.bavail * filesystem.bsize);
        const readOnly = (left[5] ?? '').split(',').includes('ro');
        items.push(Object.freeze({
          identity,
          state: readOnly ? 'read-only' : 'online',
          ...(capacityBytes === undefined ? {} : { capacityBytes }),
          ...(freeBytes === undefined ? {} : { freeBytes }),
          filesystemType,
        }));
      } catch {
        this.volumeComplete = false;
      }
    }
    return { state: 'ok', value: Object.freeze(items) };
  }
}

/** Propagates backend acquisition incompleteness into the neutral envelope. */
export class TruthfulLinuxSystemDeviceEnvironmentAdapter extends SystemDeviceEnvironmentAdapter {
  constructor(adapterId: string, private readonly truthfulBackend: TruthfulInventoryLinuxSystemDeviceBackend) {
    super(adapterId, truthfulBackend);
  }

  override async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    this.truthfulBackend.beginObservation();
    const observed = await super.observe(request);
    if (observed.channel !== 'device' || this.truthfulBackend.acquisitionComplete()) return observed;
    return Object.freeze({ ...observed, complete: false, truncated: true });
  }
}
