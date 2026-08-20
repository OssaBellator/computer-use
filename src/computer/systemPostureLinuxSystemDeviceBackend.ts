import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { KernelPostureLinuxSystemDeviceBackend } from './kernelPostureLinuxSystemDeviceBackend.js';
import type { LinuxSystemDeviceBackendOptions } from './linuxSystemDeviceBackend.js';
import type {
  SystemDeviceBackendResult,
  SystemSettingObservation,
  SystemSettingScopeIdentity,
} from './systemDeviceAdapter.js';

const MAX_ROOT_MOUNTINFO_BYTES = 8192;

function sameScope(left: SystemSettingScopeIdentity, right: SystemSettingScopeIdentity): boolean {
  return left.id === right.id && left.kind === right.kind && left.generation === right.generation;
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
  return descriptor && 'value' in descriptor && typeof descriptor.value === 'string'
    ? descriptor.value
    : undefined;
}

function revision(setting: string, state: SystemSettingObservation['state'], value?: boolean): string {
  return `linux-system-posture-${createHash('sha256')
    .update(setting).update('\0').update(state).update('\0').update(String(value))
    .digest('hex').slice(0, 16)}`;
}

function observation(
  scope: SystemSettingScopeIdentity,
  setting: string,
  state: SystemSettingObservation['state'],
  value?: boolean,
): SystemDeviceBackendResult<SystemSettingObservation> {
  return {
    state: 'ok',
    value: Object.freeze({
      scope: Object.freeze({ id: scope.id, kind: scope.kind, generation: scope.generation }),
      setting,
      state,
      ...(value === undefined ? {} : { value }),
      revision: revision(setting, state, value),
    }),
  };
}

async function readMountInfoPrefix(pathname: string): Promise<string> {
  const handle = await open(pathname, 'r');
  try {
    const buffer = Buffer.alloc(MAX_ROOT_MOUNTINFO_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const bounded = buffer.subarray(0, Math.min(bytesRead, MAX_ROOT_MOUNTINFO_BYTES)).toString('utf8');
    return bytesRead <= MAX_ROOT_MOUNTINFO_BYTES && bounded.endsWith('\n')
      ? bounded
      : bounded.slice(0, Math.max(0, bounded.lastIndexOf('\n') + 1));
  } finally {
    await handle.close();
  }
}

/** Adds coarse Linux host/system posture observations without identity-bearing text. */
export class SystemPostureLinuxSystemDeviceBackend extends KernelPostureLinuxSystemDeviceBackend {
  private readonly systemPostureProcRoot: string;
  private readonly systemPostureSysRoot: string;

  constructor(options: LinuxSystemDeviceBackendOptions = {}) {
    super(options);
    this.systemPostureProcRoot = options.procRoot ?? '/proc';
    this.systemPostureSysRoot = options.sysRoot ?? '/sys';
  }

  override async observeSystemSetting(
    scope: SystemSettingScopeIdentity,
    setting: string,
  ): Promise<SystemDeviceBackendResult<SystemSettingObservation>> {
    if (setting !== 'system.root-filesystem.read-only' && setting !== 'system.cgroup-v2.present') {
      return super.observeSystemSetting(scope, setting);
    }
    if (!sameScope(scope, this.systemSettingScope())) {
      return { state: 'unsupported-privilege', evidence: 'system-setting-scope-stale' };
    }

    if (setting === 'system.cgroup-v2.present') {
      try {
        await stat(`${this.systemPostureSysRoot}/fs/cgroup/cgroup.controllers`);
        return observation(scope, setting, 'known', true);
      } catch (error) {
        const code = errorCode(error);
        if (code === 'ENOENT') return observation(scope, setting, 'known', false);
        if (code === 'EACCES' || code === 'EPERM') {
          return { state: 'permission-denied', evidence: 'system-posture-permission-denied' };
        }
        return { state: 'unsupported-privilege', evidence: 'system-posture-unavailable' };
      }
    }

    let mountInfo: string;
    try {
      mountInfo = await readMountInfoPrefix(`${this.systemPostureProcRoot}/self/mountinfo`);
    } catch (error) {
      const code = errorCode(error);
      if (code === 'EACCES' || code === 'EPERM') {
        return { state: 'permission-denied', evidence: 'system-posture-permission-denied' };
      }
      if (code === 'ENOENT' || code === 'ENOSYS' || code === 'ENOTSUP') {
        return observation(scope, setting, 'unsupported');
      }
      return { state: 'unsupported-privilege', evidence: 'system-posture-unavailable' };
    }

    for (const line of mountInfo.split('\n')) {
      if (!line) continue;
      const separator = line.indexOf(' - ');
      if (separator < 0) continue;
      const left = line.slice(0, separator).split(' ');
      if (left.length < 6 || left[4] !== '/') continue;
      const options = (left[5] ?? '').split(',');
      return observation(scope, setting, 'known', options.includes('ro'));
    }
    return observation(scope, setting, 'unknown');
  }
}
