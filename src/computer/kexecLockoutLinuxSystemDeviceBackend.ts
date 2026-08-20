import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { ProtectedLinksLinuxSystemDeviceBackend } from './protectedLinksLinuxSystemDeviceBackend.js';
import type { LinuxSystemDeviceBackendOptions } from './linuxSystemDeviceBackend.js';
import type {
  SecuritySettingObservation,
  SecuritySettingScopeIdentity,
  SystemDeviceBackendResult,
} from './systemDeviceAdapter.js';

const MAX_KEXEC_POSTURE_BYTES = 16;
const SETTING = 'security.kexec-loading-disabled';

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
    const buffer = Buffer.alloc(MAX_KEXEC_POSTURE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await handle.close();
  }
}

function revision(value: SecuritySettingObservation['value']): string {
  return `linux-kexec-lockout-${createHash('sha256').update(String(value)).digest('hex').slice(0, 16)}`;
}

function observation(
  scope: SecuritySettingScopeIdentity,
  value: SecuritySettingObservation['value'],
): SystemDeviceBackendResult<SecuritySettingObservation> {
  return {
    state: 'ok',
    value: Object.freeze({
      scope: Object.freeze({ id: scope.id, kind: scope.kind, generation: scope.generation }),
      setting: SETTING,
      state: 'known',
      value,
      revision: revision(value),
    }),
  };
}

/** Adds coarse Linux kexec-load lockout posture. */
export class KexecLockoutLinuxSystemDeviceBackend extends ProtectedLinksLinuxSystemDeviceBackend {
  private readonly kexecProcRoot: string;

  constructor(options: LinuxSystemDeviceBackendOptions = {}) {
    super(options);
    this.kexecProcRoot = options.procRoot ?? '/proc';
  }

  override async observeSecuritySetting(
    scope: SecuritySettingScopeIdentity,
    setting: string,
  ): Promise<SystemDeviceBackendResult<SecuritySettingObservation>> {
    if (setting !== SETTING) return super.observeSecuritySetting(scope, setting);
    if (!sameScope(scope, this.securitySettingScope())) {
      return { state: 'unsupported-privilege', evidence: 'security-setting-scope-stale' };
    }

    let raw: string;
    try {
      raw = await readScalar(`${this.kexecProcRoot}/sys/kernel/kexec_load_disabled`);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return observation(scope, 'not-configured');
      if (code === 'EACCES' || code === 'EPERM') {
        return { state: 'permission-denied', evidence: 'kexec-lockout-permission-denied' };
      }
      if (code === 'ENOSYS' || code === 'ENOTSUP') {
        return { state: 'unsupported-platform', evidence: 'kexec-lockout-unsupported' };
      }
      return { state: 'unsupported-privilege', evidence: 'kexec-lockout-unavailable' };
    }

    if (raw === '1') return observation(scope, 'enabled');
    if (raw === '0') return observation(scope, 'disabled');
    return observation(scope, 'unknown');
  }
}
