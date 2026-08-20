import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, opendir, statfs } from 'node:fs/promises';
import type { Dir } from 'node:fs';
import {
  LinuxSystemDeviceBackend,
  type LinuxSystemDeviceBackendOptions,
} from './linuxSystemDeviceBackend.js';
import type {
  BoundedDeviceMetadata,
  BoundedVolumeMetadata,
  DeviceIdentity,
  SystemDeviceBackendResult,
  SystemDeviceEnumerationBudget,
  SystemDeviceIdentity,
  SystemDeviceIdentityKind,
  SystemVolumeIdentity,
} from './systemDeviceAdapter.js';

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

const VIRTUAL_FILESYSTEMS = new Set([
  'proc', 'sysfs', 'devpts', 'cgroup', 'cgroup2', 'mqueue', 'tracefs', 'securityfs',
  'debugfs', 'pstore', 'configfs', 'fusectl', 'hugetlbfs', 'ramfs',
]);
const SAFE_FILESYSTEM_TYPE = /^[a-zA-Z0-9._+-]{1,64}$/u;
const MAX_INTERNAL_TEXT_BYTES = 65_536;

interface IdentityRecord {
  readonly id: string;
  generation: number;
  fingerprint: string;
}

class EnumerationIdentityStore {
  private readonly records = new Map<string, IdentityRecord>();

  resolve<K extends SystemDeviceIdentityKind>(kind: K, locator: string, fingerprint: string): SystemDeviceIdentity<K> {
    const key = `${kind}\0${locator}`;
    let record = this.records.get(key);
    if (!record) {
      record = { id: `linux-${randomBytes(16).toString('hex')}`, generation: 1, fingerprint };
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
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string' ? descriptor.value : undefined;
}

function failure<T>(evidence: string, code?: string): SystemDeviceBackendResult<T> {
  if (code === 'EACCES' || code === 'EPERM') return { state: 'permission-denied', evidence };
  return { state: 'unsupported-privilege', evidence };
}

function fingerprint(parts: readonly (string | number | bigint)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(String(part)).update('\0');
  return hash.digest('hex').slice(0, 24);
}

function safeItemCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function safeByteCount(value: number): number {
  return Number.isFinite(value) && value > 0 ? Math.min(MAX_INTERNAL_TEXT_BYTES, Math.floor(value)) : 0;
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function finiteNonNegative(value: number): number | undefined {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

async function closeBestEffort(directory: Dir): Promise<void> {
  try { await directory.close(); } catch { /* async iteration may already close it */ }
}

export class TruthfulLinuxSystemDeviceBackend extends LinuxSystemDeviceBackend {
  private readonly enumerationIdentities = new EnumerationIdentityStore();
  private readonly sysClassRoot: string;
  private readonly procRoot: string;
  private readonly hostPlatform: NodeJS.Platform;

  constructor(options: LinuxSystemDeviceBackendOptions = {}) {
    super(options);
    this.sysClassRoot = options.sysClassRoot ?? '/sys/class';
    this.procRoot = options.procRoot ?? '/proc';
    this.hostPlatform = options.platformFamily ?? process.platform;
  }

  override async enumerateDevices(
    budget: Readonly<SystemDeviceEnumerationBudget>,
  ): Promise<SystemDeviceBackendResult<readonly BoundedDeviceMetadata[]>> {
    if (this.hostPlatform !== 'linux') return { state: 'unsupported-platform', evidence: 'linux-backend-on-non-linux' };
    const maxItems = safeItemCount(budget.maxItems);
    let textRemaining = safeByteCount(budget.maxTextBytes);
    if (maxItems === 0 || textRemaining === 0) return failure('device-enumeration-truncated');

    const items: BoundedDeviceMetadata[] = [];
    for (const source of DEVICE_CLASSES) {
      let directory: Dir;
      try {
        directory = await opendir(`${this.sysClassRoot}/${source.directory}`);
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT') continue;
        return failure('device-enumeration-incomplete', code);
      }
      try {
        for await (const entry of directory) {
          if (items.length >= maxItems) return failure('device-enumeration-truncated');
          const nameBytes = Buffer.byteLength(entry.name, 'utf8');
          if (nameBytes > textRemaining) return failure('device-enumeration-truncated');
          textRemaining -= nameBytes;
          const nativePath = `${this.sysClassRoot}/${source.directory}/${entry.name}`;
          let metadata;
          try {
            metadata = await lstat(nativePath);
          } catch (error) {
            return failure('device-enumeration-incomplete', errorCode(error));
          }
          const nativeFingerprint = fingerprint([
            metadata.dev, metadata.ino, metadata.size, Math.floor(metadata.ctimeMs), source.directory,
          ]);
          const identity = this.enumerationIdentities.resolve(source.kind, nativePath, nativeFingerprint) as DeviceIdentity;
          items.push(Object.freeze({ identity, category: source.category, presence: 'present', state: 'ready' }));
        }
      } finally {
        await closeBestEffort(directory);
      }
    }
    return { state: 'ok', value: Object.freeze(items) };
  }

  override async enumerateVolumes(
    budget: Readonly<SystemDeviceEnumerationBudget>,
  ): Promise<SystemDeviceBackendResult<readonly BoundedVolumeMetadata[]>> {
    if (this.hostPlatform !== 'linux') return { state: 'unsupported-platform', evidence: 'linux-backend-on-non-linux' };
    const maxItems = safeItemCount(budget.maxItems);
    const maxTextBytes = safeByteCount(budget.maxTextBytes);
    if (maxItems === 0 || maxTextBytes === 0) return failure('volume-enumeration-truncated');

    let handle;
    try {
      handle = await open(`${this.procRoot}/self/mountinfo`, 'r');
      const buffer = Buffer.alloc(maxTextBytes);
      const { bytesRead } = await handle.read(buffer, 0, maxTextBytes, 0);
      if (bytesRead === maxTextBytes) return failure('volume-enumeration-truncated');
      const text = buffer.subarray(0, bytesRead).toString('utf8');
      if (text.length > 0 && !text.endsWith('\n')) return failure('volume-enumeration-incomplete');

      const items: BoundedVolumeMetadata[] = [];
      for (const line of text.split('\n')) {
        if (!line) continue;
        const separator = line.indexOf(' - ');
        if (separator < 0) return failure('volume-enumeration-incomplete');
        const left = line.slice(0, separator).split(' ');
        const right = line.slice(separator + 3).split(' ');
        if (left.length < 6 || right.length < 2) return failure('volume-enumeration-incomplete');
        const filesystemType = right[0] ?? '';
        if (!SAFE_FILESYSTEM_TYPE.test(filesystemType) || VIRTUAL_FILESYSTEMS.has(filesystemType)) continue;
        if (items.length >= maxItems) return failure('volume-enumeration-truncated');
        const mountPoint = decodeMountInfoPath(left[4] ?? '');
        if (!mountPoint.startsWith('/')) return failure('volume-enumeration-incomplete');
        let filesystem;
        try {
          filesystem = await statfs(mountPoint);
        } catch (error) {
          return failure('volume-enumeration-incomplete', errorCode(error));
        }
        const identity = this.enumerationIdentities.resolve(
          'volume', mountPoint, fingerprint([left[0] ?? '', left[2] ?? '', filesystemType]),
        ) as SystemVolumeIdentity;
        const capacityBytes = finiteNonNegative(filesystem.blocks * filesystem.bsize);
        const freeBytes = finiteNonNegative(filesystem.bavail * filesystem.bsize);
        items.push(Object.freeze({
          identity,
          state: (left[5] ?? '').split(',').includes('ro') ? 'read-only' : 'online',
          ...(capacityBytes === undefined ? {} : { capacityBytes }),
          ...(freeBytes === undefined ? {} : { freeBytes }),
          filesystemType,
        }));
      }
      return { state: 'ok', value: Object.freeze(items) };
    } catch (error) {
      return failure('volume-enumeration-incomplete', errorCode(error));
    } finally {
      if (handle) try { await handle.close(); } catch {}
    }
  }
}
