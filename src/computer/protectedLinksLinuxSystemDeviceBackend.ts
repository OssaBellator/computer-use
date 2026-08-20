import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { KernelVisibilityLinuxSystemDeviceBackend } from './kernelVisibilityLinuxSystemDeviceBackend.js';
import type { LinuxSystemDeviceBackendOptions } from './linuxSystemDeviceBackend.js';
import type {
  SecuritySettingObservation,
  SecuritySettingScopeIdentity,
  SystemDeviceBackendResult,
} from './systemDeviceAdapter.js';

const MAX_PROTECTED_LINK_BYTES = 16;

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

async function readScalar(pathname: string): Promise<string> {
  const handle = await open(pathname, 'r');
  try {
    const buffer = Buffer.alloc(MAX_PROTECTED_LINK_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await handle.close();
  }
}

function revision(setting: string, value: SecuritySettingObservation['value']): string {
  return `linux-protected-links-${createHash('sha256').update(setting).update('\0').update(String(value)).digest('hex').slice(0, 16)}`;
}

function observation(
  scope: SecuritySettingScopeIdentity,
  setting: string,
  value: SecuritySettingObservation['value'],
): SystemDeviceBackendResult<SecuritySettingObservation> {
  return {
    state: 'ok',
    value: Object.freeze({
      scope: Object.freeze({ id: scope.id, kind: scope.kind, generation: scope.generation }),
      setting,
      state: 'known',
      value,
      revision: revision(setting, value),
    }),
  };
}

/** Adds coarse Linux protected hardlink/symlink posture without exposing sysctl text. */
export class ProtectedLinksLinuxSystemDeviceBackend extends KernelVisibilityLinuxSystemDeviceBackend {
  private readonly protectedLinksProcRoot: string;

  constructor(options: LinuxSystemDeviceBackendOptions = {}) {
    super(options);
    this.protectedLinksProcRoot = options.procRoot ?? '/proc';
  }

  override async observeSecuritySetting(
    scope: SecuritySettingScopeIdentity,
    setting: string,
  ): Promise<SystemDeviceBackendResult<SecuritySettingObservation>> {
    if (setting !== 'security.protected-hardlinks' && setting !== 'security.protected-symlinks') {
      return super.observeSecuritySetting(scope, setting);
    }
    if (!sameScope(scope, this.securitySettingScope())) {
      return { state: 'unsupported-privilege', evidence: 'security-setting-scope-stale' };
    }

    const pathname = setting === 'security.protected-hardlinks'
      ? `${this.protectedLinksProcRoot}/sys/fs/protected_hardlinks`
      : `${this.protectedLinksProcRoot}/sys/fs/protected_symlinks`;
    let raw: string;
    try {
      raw = await readScalar(pathname);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return observation(scope, setting, 'not-configured');
      if (code === 'EACCES' || code === 'EPERM') {
        return { state: 'permission-denied', evidence: 'protected-links-permission-denied' };
      }
      if (code === 'ENOSYS' || code === 'ENOTSUP') {
        return { state: 'unsupported-platform', evidence: 'protected-links-unsupported' };
      }
      return { state: 'unsupported-privilege', evidence: 'protected-links-unavailable' };
    }

    if (raw === '1') return observation(scope, setting, 'enabled');
    if (raw === '0') return observation(scope, setting, 'disabled');
    return observation(scope, setting, 'unknown');
  }
}
