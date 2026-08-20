import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import {
  ScopeBoundLinuxSystemDeviceBackend,
} from './scopeBoundLinuxSystemDeviceBackend.js';
import type { LinuxSystemDeviceBackendOptions } from './linuxSystemDeviceBackend.js';
import type {
  SecuritySettingObservation,
  SecuritySettingScopeIdentity,
  SystemDeviceBackendResult,
} from './systemDeviceAdapter.js';

const MAX_POSTURE_BYTES = 32;

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

async function readSmallScalar(pathname: string): Promise<string> {
  const handle = await open(pathname, 'r');
  try {
    const buffer = Buffer.alloc(MAX_POSTURE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await handle.close();
  }
}

function revision(setting: string, value: SecuritySettingObservation['value']): string {
  return `linux-posture-${createHash('sha256').update(setting).update('\0').update(String(value)).digest('hex').slice(0, 20)}`;
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

/** Adds coarse, scalar-only Linux security posture observations. */
export class PostureLinuxSystemDeviceBackend extends ScopeBoundLinuxSystemDeviceBackend {
  private readonly postureProcRoot: string;

  constructor(options: LinuxSystemDeviceBackendOptions = {}) {
    super(options);
    this.postureProcRoot = options.procRoot ?? '/proc';
  }

  override async observeSecuritySetting(
    scope: SecuritySettingScopeIdentity,
    setting: string,
  ): Promise<SystemDeviceBackendResult<SecuritySettingObservation>> {
    if (setting !== 'security.aslr' && setting !== 'security.yama-ptrace') {
      return super.observeSecuritySetting(scope, setting);
    }
    if (!sameScope(scope, this.securitySettingScope())) {
      return { state: 'unsupported-privilege', evidence: 'security-setting-scope-stale' };
    }

    const pathname = setting === 'security.aslr'
      ? `${this.postureProcRoot}/sys/kernel/randomize_va_space`
      : `${this.postureProcRoot}/sys/kernel/yama/ptrace_scope`;
    let raw: string;
    try {
      raw = await readSmallScalar(pathname);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return observation(scope, setting, 'not-configured');
      if (code === 'EACCES' || code === 'EPERM') {
        return { state: 'permission-denied', evidence: 'security-posture-permission-denied' };
      }
      if (code === 'ENOSYS' || code === 'ENOTSUP') {
        return { state: 'unsupported-platform', evidence: 'security-posture-unsupported' };
      }
      return { state: 'unsupported-privilege', evidence: 'security-posture-unavailable' };
    }

    if (!/^\d+$/u.test(raw)) return observation(scope, setting, 'unknown');
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric) || numeric < 0) return observation(scope, setting, 'unknown');
    return observation(scope, setting, numeric === 0 ? 'disabled' : 'enabled');
  }
}
