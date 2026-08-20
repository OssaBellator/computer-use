import { createHash } from 'node:crypto';
import { open } from 'node:fs/promises';
import { PostureLinuxSystemDeviceBackend } from './postureLinuxSystemDeviceBackend.js';
import type { LinuxSystemDeviceBackendOptions } from './linuxSystemDeviceBackend.js';
import type {
  SecuritySettingObservation,
  SecuritySettingScopeIdentity,
  SystemDeviceBackendResult,
} from './systemDeviceAdapter.js';

const MAX_KERNEL_POSTURE_BYTES = 32;

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
    const buffer = Buffer.alloc(MAX_KERNEL_POSTURE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead).toString('utf8').trim();
  } finally {
    await handle.close();
  }
}

function postureRevision(setting: string, value: SecuritySettingObservation['value']): string {
  return `linux-kernel-posture-${createHash('sha256').update(setting).update('\0').update(String(value)).digest('hex').slice(0, 16)}`;
}

function result(
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
      revision: postureRevision(setting, value),
    }),
  };
}

/** Additional scalar-only Linux kernel-hardening posture observations. */
export class KernelPostureLinuxSystemDeviceBackend extends PostureLinuxSystemDeviceBackend {
  private readonly kernelPostureProcRoot: string;

  constructor(options: LinuxSystemDeviceBackendOptions = {}) {
    super(options);
    this.kernelPostureProcRoot = options.procRoot ?? '/proc';
  }

  override async observeSecuritySetting(
    scope: SecuritySettingScopeIdentity,
    setting: string,
  ): Promise<SystemDeviceBackendResult<SecuritySettingObservation>> {
    if (setting !== 'security.module-loading-locked' && setting !== 'security.unprivileged-bpf-disabled') {
      return super.observeSecuritySetting(scope, setting);
    }
    if (!sameScope(scope, this.securitySettingScope())) {
      return { state: 'unsupported-privilege', evidence: 'security-setting-scope-stale' };
    }

    const pathname = setting === 'security.module-loading-locked'
      ? `${this.kernelPostureProcRoot}/sys/kernel/modules_disabled`
      : `${this.kernelPostureProcRoot}/sys/kernel/unprivileged_bpf_disabled`;
    let raw: string;
    try {
      raw = await readScalar(pathname);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'ENOENT') return result(scope, setting, 'not-configured');
      if (code === 'EACCES' || code === 'EPERM') {
        return { state: 'permission-denied', evidence: 'kernel-posture-permission-denied' };
      }
      if (code === 'ENOSYS' || code === 'ENOTSUP') {
        return { state: 'unsupported-platform', evidence: 'kernel-posture-unsupported' };
      }
      return { state: 'unsupported-privilege', evidence: 'kernel-posture-unavailable' };
    }

    if (!/^\d+$/u.test(raw)) return result(scope, setting, 'unknown');
    const numeric = Number(raw);
    if (!Number.isSafeInteger(numeric) || numeric < 0) return result(scope, setting, 'unknown');
    return result(scope, setting, numeric === 0 ? 'disabled' : 'enabled');
  }
}
