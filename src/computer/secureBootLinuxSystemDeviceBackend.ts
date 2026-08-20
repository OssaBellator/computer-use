import { createHash } from 'node:crypto';
import { open, opendir } from 'node:fs/promises';
import { SystemPostureLinuxSystemDeviceBackend } from './systemPostureLinuxSystemDeviceBackend.js';
import type { LinuxSystemDeviceBackendOptions } from './linuxSystemDeviceBackend.js';
import type {
  SecuritySettingObservation,
  SecuritySettingScopeIdentity,
  SystemDeviceBackendResult,
} from './systemDeviceAdapter.js';

const MAX_EFIVAR_ENTRIES = 128;
/** UEFI global-variable GUID for the authoritative SecureBoot variable. */
const SECURE_BOOT_EFIVAR = 'SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c';

function sameScope(left: SecuritySettingScopeIdentity, right: SecuritySettingScopeIdentity): boolean {
  return left.id === right.id && left.kind === right.kind && left.generation === right.generation;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function revision(value: SecuritySettingObservation['value']): string {
  return `linux-secure-boot-${createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

function observation(
  scope: SecuritySettingScopeIdentity,
  value: SecuritySettingObservation['value'],
): SystemDeviceBackendResult<SecuritySettingObservation> {
  return {
    state: 'ok',
    value: Object.freeze({
      scope: Object.freeze({ id: scope.id, kind: scope.kind, generation: scope.generation }),
      setting: 'security.secure-boot',
      state: 'known',
      value,
      revision: revision(value),
    }),
  };
}

/** Adds a bounded coarse Secure Boot posture read from Linux efivarfs. */
export class SecureBootLinuxSystemDeviceBackend extends SystemPostureLinuxSystemDeviceBackend {
  private readonly secureBootSysRoot: string;

  constructor(options: LinuxSystemDeviceBackendOptions = {}) {
    super(options);
    this.secureBootSysRoot = options.sysRoot ?? '/sys';
  }

  override async observeSecuritySetting(
    scope: SecuritySettingScopeIdentity,
    setting: string,
  ): Promise<SystemDeviceBackendResult<SecuritySettingObservation>> {
    if (setting !== 'security.secure-boot') return super.observeSecuritySetting(scope, setting);
    if (!sameScope(scope, this.securitySettingScope())) {
      return { state: 'unsupported-privilege', evidence: 'security-setting-scope-stale' };
    }

    const efivars = `${this.secureBootSysRoot}/firmware/efi/efivars`;
    let directory;
    try {
      directory = await opendir(efivars);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return observation(scope, 'not-configured');
      if (code === 'EACCES' || code === 'EPERM') {
        return { state: 'permission-denied', evidence: 'secure-boot-permission-denied' };
      }
      return { state: 'unsupported-privilege', evidence: 'secure-boot-unavailable' };
    }

    let secureBootPath: string | undefined;
    let scanned = 0;
    try {
      for await (const entry of directory) {
        scanned += 1;
        if (scanned > MAX_EFIVAR_ENTRIES) return observation(scope, 'unknown');
        if (entry.name === SECURE_BOOT_EFIVAR) {
          secureBootPath = `${efivars}/${SECURE_BOOT_EFIVAR}`;
          break;
        }
      }
    } finally {
      try { await directory.close(); } catch { /* async iterator may already close it */ }
    }
    if (!secureBootPath) return observation(scope, 'not-configured');

    let handle;
    try {
      handle = await open(secureBootPath, 'r');
      const bytes = Buffer.alloc(5);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead < 5) return observation(scope, 'unknown');
      const stateByte = bytes[4];
      return observation(scope, stateByte === 1 ? 'enabled' : stateByte === 0 ? 'disabled' : 'unknown');
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EACCES' || code === 'EPERM') {
        return { state: 'permission-denied', evidence: 'secure-boot-permission-denied' };
      }
      if (code === 'ENOENT') return observation(scope, 'unknown');
      return { state: 'unsupported-privilege', evidence: 'secure-boot-unavailable' };
    } finally {
      try { await handle?.close(); } catch { /* best effort close */ }
    }
  }
}
