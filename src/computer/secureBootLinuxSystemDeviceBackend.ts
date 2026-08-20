import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { SystemPostureLinuxSystemDeviceBackend } from './systemPostureLinuxSystemDeviceBackend.js';
import type { LinuxSystemDeviceBackendOptions } from './linuxSystemDeviceBackend.js';
import type {
  SecuritySettingObservation,
  SecuritySettingScopeIdentity,
  SystemDeviceBackendResult,
} from './systemDeviceAdapter.js';

const SECURE_BOOT_VARIABLE = 'SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c';

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

/** Reads only the well-known UEFI global Secure Boot variable and exposes coarse posture. */
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

    const secureBootPath = `${this.secureBootSysRoot}/firmware/efi/efivars/${SECURE_BOOT_VARIABLE}`;
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
      if (code === 'ENOENT') return observation(scope, 'not-configured');
      if (code === 'EACCES' || code === 'EPERM') {
        return { state: 'permission-denied', evidence: 'secure-boot-permission-denied' };
      }
      if (code === 'ENOSYS' || code === 'ENOTSUP') {
        return { state: 'unsupported-platform', evidence: 'secure-boot-unsupported' };
      }
      return { state: 'unsupported-privilege', evidence: 'secure-boot-unavailable' };
    } finally {
      try { await handle?.close(); } catch { /* best effort close */ }
    }
  }
}
