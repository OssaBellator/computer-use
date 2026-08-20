import {
  LinuxSystemDeviceBackend,
  type LinuxSystemDeviceBackendOptions,
} from './linuxSystemDeviceBackend.js';
import type {
  SecuritySettingObservation,
  SecuritySettingScopeIdentity,
  SystemDeviceBackendResult,
  SystemSettingObservation,
  SystemSettingScopeIdentity,
} from './systemDeviceAdapter.js';

function sameScope(
  left: SystemSettingScopeIdentity | SecuritySettingScopeIdentity,
  right: SystemSettingScopeIdentity | SecuritySettingScopeIdentity,
): boolean {
  return left.id === right.id && left.kind === right.kind && left.generation === right.generation;
}

/**
 * Linux backend variant that binds typed setting observations to backend-issued
 * opaque scope identities. Fabricated or stale scopes fail closed before any
 * setting-specific host read occurs.
 */
export class ScopeBoundLinuxSystemDeviceBackend extends LinuxSystemDeviceBackend {
  constructor(options: LinuxSystemDeviceBackendOptions = {}) {
    super(options);
  }

  override async observeSystemSetting(
    scope: SystemSettingScopeIdentity,
    setting: string,
  ): Promise<SystemDeviceBackendResult<SystemSettingObservation>> {
    if (!sameScope(scope, this.systemSettingScope())) {
      return { state: 'unsupported-privilege', evidence: 'system-setting-scope-stale' };
    }
    return super.observeSystemSetting(scope, setting);
  }

  override async observeSecuritySetting(
    scope: SecuritySettingScopeIdentity,
    setting: string,
  ): Promise<SystemDeviceBackendResult<SecuritySettingObservation>> {
    if (!sameScope(scope, this.securitySettingScope())) {
      return { state: 'unsupported-privilege', evidence: 'security-setting-scope-stale' };
    }
    return super.observeSecuritySetting(scope, setting);
  }
}
