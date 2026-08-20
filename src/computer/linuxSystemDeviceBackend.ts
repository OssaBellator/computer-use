import { createHash, randomBytes } from 'node:crypto';
import { lstat, open, opendir, stat, statfs } from 'node:fs/promises';
import { arch, cpus, platform, totalmem } from 'node:os';
import {
  SystemDeviceEnvironmentAdapter,
  type BoundedDeviceMetadata,
  type BoundedSystemInformation,
  type BoundedVolumeMetadata,
  type DeviceIdentity,
  type SecuritySettingObservation,
  type SecuritySettingScopeIdentity,
  type SystemDeviceBackend,
  type SystemDeviceBackendResult,
  type SystemDeviceEnumerationBudget,
  type SystemDeviceIdentity,
  type SystemDeviceIdentityKind,
  type SystemDeviceMutationBaseline,
  type SystemDeviceMutationDispatch,
  type SystemDeviceMutationPayload,
  type SystemDeviceMutationVerification,
  type SystemDevicePrivilegeState,
  type SystemSettingObservation,
  type SystemSettingScopeIdentity,
  type SystemVolumeIdentity,
} from './systemDeviceAdapter.js';

const MAX_INTERNAL_TEXT_BYTES = 65_536;
const MAX_SETTING_TEXT_BYTES = 256;
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

class OpaqueIdentityStore {
  private readonly records = new Map<string, IdentityRecord>();

  resolve<K extends SystemDeviceIdentityKind>(kind: K, locator: string, fingerprint: string): SystemDeviceIdentity<K> {
    const key = `${kind}\0${locator}`;
    let record = this.records.get(key);
    if (!record) {
      record = {
        id: `linux-${randomBytes(16).toString('hex')}`,
        generation: 1,
        fingerprint,
      };
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

function backendFailure<T>(error: unknown): SystemDeviceBackendResult<T> {
  const code = errorCode(error);
  if (code === 'EACCES' || code === 'EPERM') return { state: 'permission-denied', evidence: 'host-permission-denied' };
  if (code === 'ENOSYS' || code === 'ENOTSUP') return { state: 'unsupported-platform', evidence: 'host-feature-unsupported' };
  return { state: 'unsupported-privilege', evidence: 'host-observation-unavailable' };
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function fingerprint(parts: readonly (string | number | bigint)[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(String(part)).update('\0');
  return hash.digest('hex').slice(0, 24);
}

function safeByteCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.min(MAX_INTERNAL_TEXT_BYTES, Math.floor(value)));
}

function safeItemCount(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.max(0, Math.floor(value));
}

async function readBoundedPrefix(pathname: string, maxBytes: number): Promise<Buffer> {
  const limit = safeByteCount(maxBytes);
  if (limit === 0) return Buffer.alloc(0);
  const handle = await open(pathname, 'r');
  try {
    const buffer = Buffer.alloc(limit);
    const { bytesRead } = await handle.read(buffer, 0, limit, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function readSmallText(pathname: string): Promise<string> {
  return (await readBoundedPrefix(pathname, MAX_SETTING_TEXT_BYTES)).toString('utf8').trim();
}

function decodeMountInfoPath(value: string): string {
  return value.replace(/\\(040|011|012|134)/gu, (_match, octal: string) => String.fromCharCode(Number.parseInt(octal, 8)));
}

function finiteNonNegative(value: number): number | undefined {
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function frozenSystemInformation(): BoundedSystemInformation {
  const processorCount = cpus().length;
  const memory = totalmem();
  return Object.freeze({
    platformFamily: 'linux',
    architecture: arch(),
    ...(Number.isSafeInteger(processorCount) && processorCount >= 0 ? { logicalProcessorCount: processorCount } : {}),
    ...(Number.isSafeInteger(memory) && memory >= 0 ? { totalMemoryBytes: memory } : {}),
  });
}

function scopeClone<T extends SystemSettingScopeIdentity | SecuritySettingScopeIdentity>(scope: T): T {
  return Object.freeze({ id: scope.id, kind: scope.kind, generation: scope.generation }) as T;
}

function revision(setting: string, value: string | number | boolean | undefined): string {
  return `linux-${createHash('sha256').update(setting).update('\0').update(String(value)).digest('hex').slice(0, 24)}`;
}

export interface LinuxSystemDeviceBackendOptions {
  readonly sysClassRoot?: string;
  readonly procRoot?: string;
  readonly sysRoot?: string;
  readonly platformFamily?: NodeJS.Platform;
}

/**
 * Read-first Linux backend for SystemDeviceEnvironmentAdapter.
 *
 * The backend never exposes sysfs names, mount paths, mount sources, hostnames,
 * usernames, serials, or native device IDs through neutral identities. Native
 * locators are retained only inside this backend and mapped to random opaque IDs.
 * No mutation method is implemented: the mutation seam fails closed even if a
 * caller separately constructs an adapter with mutation-related dependencies.
 */
export class LinuxSystemDeviceBackend implements SystemDeviceBackend {
  readonly platformFamily = 'linux';
  readonly mutationSupport = 'none' as const;
  private readonly identities = new OpaqueIdentityStore();
  private readonly sysClassRoot: string;
  private readonly procRoot: string;
  private readonly sysRoot: string;
  private readonly hostPlatform: NodeJS.Platform;

  constructor(options: LinuxSystemDeviceBackendOptions = {}) {
    this.sysClassRoot = options.sysClassRoot ?? '/sys/class';
    this.procRoot = options.procRoot ?? '/proc';
    this.sysRoot = options.sysRoot ?? '/sys';
    this.hostPlatform = options.platformFamily ?? platform();
  }

  systemSettingScope(): SystemSettingScopeIdentity {
    return this.identities.resolve('system-setting-scope', 'coarse-system-settings', 'linux-system-settings-v1');
  }

  securitySettingScope(): SecuritySettingScopeIdentity {
    return this.identities.resolve('security-setting-scope', 'coarse-security-settings', 'linux-security-settings-v1');
  }

  async privilegeState(): Promise<SystemDevicePrivilegeState> {
    return this.hostPlatform === 'linux'
      ? Object.freeze({ state: 'available' })
      : Object.freeze({ state: 'unsupported-platform', reason: 'linux-backend-on-non-linux' });
  }

  async systemInformation(): Promise<SystemDeviceBackendResult<BoundedSystemInformation>> {
    if (this.hostPlatform !== 'linux') return { state: 'unsupported-platform', evidence: 'linux-backend-on-non-linux' };
    return { state: 'ok', value: frozenSystemInformation() };
  }

  async enumerateDevices(
    budget: Readonly<SystemDeviceEnumerationBudget>,
  ): Promise<SystemDeviceBackendResult<readonly BoundedDeviceMetadata[]>> {
    if (this.hostPlatform !== 'linux') return { state: 'unsupported-platform', evidence: 'linux-backend-on-non-linux' };
    const maxItems = safeItemCount(budget.maxItems);
    let textRemaining = safeByteCount(budget.maxTextBytes);
    if (maxItems === 0 || textRemaining === 0) return { state: 'ok', value: Object.freeze([]) };

    const items: BoundedDeviceMetadata[] = [];
    let permissionFailure = false;
    for (const source of DEVICE_CLASSES) {
      if (items.length >= maxItems || textRemaining <= 0) break;
      const directoryPath = `${this.sysClassRoot}/${source.directory}`;
      let directory;
      try {
        directory = await opendir(directoryPath);
      } catch (error) {
        const code = errorCode(error);
        if (code === 'EACCES' || code === 'EPERM') permissionFailure = true;
        continue;
      }
      try {
        for await (const entry of directory) {
          if (items.length >= maxItems || textRemaining <= 0) break;
          if (entry.name === '.' || entry.name === '..') continue;
          const nameBytes = utf8Bytes(entry.name);
          if (nameBytes > textRemaining) {
            textRemaining = 0;
            break;
          }
          textRemaining -= nameBytes;
          const nativePath = `${directoryPath}/${entry.name}`;
          try {
            const metadata = await lstat(nativePath);
            const nativeFingerprint = fingerprint([
              metadata.dev, metadata.ino, metadata.size, Math.floor(metadata.ctimeMs), source.directory,
            ]);
            const identity = this.identities.resolve(source.kind, nativePath, nativeFingerprint) as DeviceIdentity;
            items.push(Object.freeze({
              identity,
              category: source.category,
              presence: 'present',
              state: 'ready',
            }));
          } catch (error) {
            const code = errorCode(error);
            if (code === 'EACCES' || code === 'EPERM') permissionFailure = true;
          }
        }
      } finally {
        try { await directory.close(); } catch { /* already closed by async iterator */ }
      }
    }

    if (items.length === 0 && permissionFailure) {
      return { state: 'permission-denied', evidence: 'device-enumeration-permission-denied' };
    }
    return { state: 'ok', value: Object.freeze(items) };
  }

  async enumerateVolumes(
    budget: Readonly<SystemDeviceEnumerationBudget>,
  ): Promise<SystemDeviceBackendResult<readonly BoundedVolumeMetadata[]>> {
    if (this.hostPlatform !== 'linux') return { state: 'unsupported-platform', evidence: 'linux-backend-on-non-linux' };
    const maxItems = safeItemCount(budget.maxItems);
    const maxTextBytes = safeByteCount(budget.maxTextBytes);
    if (maxItems === 0 || maxTextBytes === 0) return { state: 'ok', value: Object.freeze([]) };

    let raw: Buffer;
    try {
      raw = await readBoundedPrefix(`${this.procRoot}/self/mountinfo`, maxTextBytes);
    } catch (error) {
      return backendFailure(error);
    }
    const text = raw.toString('utf8');
    const completePrefix = text.endsWith('\n') ? text : text.slice(0, Math.max(0, text.lastIndexOf('\n') + 1));
    const lines = completePrefix.split('\n');
    const items: BoundedVolumeMetadata[] = [];

    for (const line of lines) {
      if (!line || items.length >= maxItems) break;
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
        const mountFingerprint = fingerprint([left[0] ?? '', left[2] ?? '', filesystemType]);
        const identity = this.identities.resolve('volume', mountPoint, mountFingerprint) as SystemVolumeIdentity;
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
        // Mounts can disappear or become inaccessible during enumeration. Skip the
        // raced entry rather than retaining a stale native locator.
      }
    }
    return { state: 'ok', value: Object.freeze(items) };
  }

  async observeSystemSetting(
    scope: SystemSettingScopeIdentity,
    setting: string,
  ): Promise<SystemDeviceBackendResult<SystemSettingObservation>> {
    if (this.hostPlatform !== 'linux') return { state: 'unsupported-platform', evidence: 'linux-backend-on-non-linux' };
    try {
      let value: boolean;
      switch (setting) {
        case 'system.efi.present': {
          try {
            await stat(`${this.sysRoot}/firmware/efi`);
            value = true;
          } catch (error) {
            if (errorCode(error) === 'ENOENT') value = false;
            else return backendFailure(error);
          }
          break;
        }
        case 'system.swap.enabled': {
          const raw = await readBoundedPrefix(`${this.procRoot}/swaps`, 4096);
          const lines = raw.toString('utf8').split('\n').filter((line) => line.trim().length > 0);
          value = lines.length > 1;
          break;
        }
        default:
          return { state: 'ok', value: Object.freeze({
            scope: scopeClone(scope), setting, state: 'unsupported', revision: revision(setting, undefined),
          }) };
      }
      return { state: 'ok', value: Object.freeze({
        scope: scopeClone(scope), setting, state: 'known', value, revision: revision(setting, value),
      }) };
    } catch (error) {
      return backendFailure(error);
    }
  }

  async observeSecuritySetting(
    scope: SecuritySettingScopeIdentity,
    setting: string,
  ): Promise<SystemDeviceBackendResult<SecuritySettingObservation>> {
    if (this.hostPlatform !== 'linux') return { state: 'unsupported-platform', evidence: 'linux-backend-on-non-linux' };
    const pathBySetting: Readonly<Record<string, string>> = Object.freeze({
      'security.apparmor': `${this.sysRoot}/module/apparmor/parameters/enabled`,
      'security.selinux': `${this.sysRoot}/fs/selinux/enforce`,
      'security.lockdown': `${this.sysRoot}/kernel/security/lockdown`,
    });
    const pathname = pathBySetting[setting];
    if (!pathname) {
      return { state: 'ok', value: Object.freeze({
        scope: scopeClone(scope), setting, state: 'unsupported', revision: revision(setting, undefined),
      }) };
    }

    let raw: string;
    try {
      raw = await readSmallText(pathname);
    } catch (error) {
      if (errorCode(error) === 'ENOENT') {
        const value = 'not-configured' as const;
        return { state: 'ok', value: Object.freeze({
          scope: scopeClone(scope), setting, state: 'known', value, revision: revision(setting, value),
        }) };
      }
      return backendFailure(error);
    }

    let value: SecuritySettingObservation['value'] = 'unknown';
    if (setting === 'security.apparmor') value = /^y(?:es)?$/iu.test(raw) ? 'enabled' : /^n(?:o)?$/iu.test(raw) ? 'disabled' : 'unknown';
    else if (setting === 'security.selinux') value = raw === '1' ? 'enabled' : raw === '0' ? 'disabled' : 'unknown';
    else if (setting === 'security.lockdown') {
      const selected = /\[([^\]]+)\]/u.exec(raw)?.[1]?.toLowerCase();
      value = selected === 'none' ? 'disabled' : selected ? 'enabled' : 'unknown';
    }
    return { state: 'ok', value: Object.freeze({
      scope: scopeClone(scope), setting, state: 'known', value, revision: revision(setting, value),
    }) };
  }

  async freshMutationBaseline(
    _target: SystemDeviceIdentity,
    _setting: string,
  ): Promise<SystemDeviceBackendResult<SystemDeviceMutationBaseline>> {
    return { state: 'unsupported-privilege', evidence: 'read-only-backend' };
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

/** Construct the production Linux adapter in its intentionally read-only form. */
export function createLinuxSystemDeviceEnvironmentAdapter(adapterId: string): SystemDeviceEnvironmentAdapter {
  return new SystemDeviceEnvironmentAdapter(adapterId, new LinuxSystemDeviceBackend());
}
