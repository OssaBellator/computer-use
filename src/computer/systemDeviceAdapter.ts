import {
  computerActionMayAutoRetry,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEffectClass,
  type ComputerEnvironmentAdapter,
  type ComputerEnvironmentAdapterDescriptor,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
} from './environmentAdapter.js';

export const SYSTEM_DEVICE_IDENTITY_KINDS = [
  'device',
  'peripheral',
  'volume',
  'system-setting-scope',
  'security-setting-scope',
] as const;

export type SystemDeviceIdentityKind = typeof SYSTEM_DEVICE_IDENTITY_KINDS[number];

export interface SystemDeviceIdentity<K extends SystemDeviceIdentityKind = SystemDeviceIdentityKind> {
  /** Stable adapter-local token. It must not contain a serial number, hostname, account, path, or secret. */
  id: string;
  kind: K;
  /** Increments whenever replacement/re-enumeration makes an older handle unsafe to use. */
  generation: number;
}

export type DeviceIdentity = SystemDeviceIdentity<'device' | 'peripheral'>;
export type SystemVolumeIdentity = SystemDeviceIdentity<'volume'>;
export type SystemSettingScopeIdentity = SystemDeviceIdentity<'system-setting-scope'>;
export type SecuritySettingScopeIdentity = SystemDeviceIdentity<'security-setting-scope'>;

export type SystemDeviceAccessState =
  | 'available'
  | 'unsupported-platform'
  | 'unsupported-privilege'
  | 'permission-denied';

export interface SystemDevicePrivilegeState {
  state: SystemDeviceAccessState;
  /** Bounded machine code only. Do not include usernames, groups, tokens, or policy text. */
  reason?: string;
}

export type DevicePresence = 'present' | 'absent' | 'unknown';
export type DeviceOperationalState = 'ready' | 'busy' | 'disabled' | 'degraded' | 'unknown';

export interface BoundedDeviceMetadata {
  identity: DeviceIdentity;
  category: 'display' | 'input' | 'audio' | 'camera' | 'printer' | 'storage' | 'network' | 'other';
  presence: DevicePresence;
  state: DeviceOperationalState;
  /** Optional human-readable class/model label; never a serial, MAC, IMEI, host name, or account identifier. */
  label?: string;
}

export interface BoundedVolumeMetadata {
  identity: SystemVolumeIdentity;
  state: 'online' | 'offline' | 'read-only' | 'unknown';
  removable?: boolean;
  capacityBytes?: number;
  freeBytes?: number;
  /** Filesystem type only; mount paths and globally unique storage identifiers are deliberately omitted. */
  filesystemType?: string;
}

export interface BoundedSystemInformation {
  platformFamily: string;
  architecture?: string;
  logicalProcessorCount?: number;
  totalMemoryBytes?: number;
}

export interface SystemSettingObservation {
  scope: SystemSettingScopeIdentity;
  setting: string;
  state: 'known' | 'unsupported' | 'permission-denied' | 'unknown';
  /** Backend-normalized scalar/enum value. No paths, account identifiers, credentials, or free-form secret-bearing blobs. */
  value?: string | number | boolean;
  revision: string;
}

export interface SecuritySettingObservation {
  scope: SecuritySettingScopeIdentity;
  setting: string;
  state: 'known' | 'unsupported' | 'permission-denied' | 'unknown';
  /** Deliberately coarse: security observations report posture/state, never credentials, keys, tokens, rulesets, or secrets. */
  value?: 'enabled' | 'disabled' | 'managed' | 'not-configured' | 'unknown';
  revision: string;
}

export interface SystemDeviceSnapshot {
  access: SystemDevicePrivilegeState;
  system?: BoundedSystemInformation;
  devices: readonly BoundedDeviceMetadata[];
  volumes: readonly BoundedVolumeMetadata[];
}

export type SystemDeviceBackendFailure =
  | { state: 'unsupported-platform'; evidence: string }
  | { state: 'unsupported-privilege'; evidence: string }
  | { state: 'permission-denied'; evidence: string };

export type SystemDeviceBackendResult<T> =
  | { state: 'ok'; value: T }
  | SystemDeviceBackendFailure;

export interface SystemDeviceMutationBaseline {
  target: SystemDeviceIdentity;
  configurationRevision: string;
}

export interface SystemDeviceMutationApproval {
  approved: true;
  /** Opaque approval token used only for equality/binding. It must be bounded and non-secret. */
  approvalId: string;
  effect: Exclude<ComputerEffectClass, 'observe-only'>;
  target: SystemDeviceIdentity;
  configurationRevision: string;
}

export interface SystemDeviceMutationPayload {
  operation:
    | 'system-setting-change'
    | 'security-setting-change'
    | 'peripheral-configuration';
  target: SystemDeviceIdentity;
  setting: string;
  /** Backend-normalized bounded scalar/enum only. */
  value: string | number | boolean;
  approval: SystemDeviceMutationApproval;
}

export interface SystemDeviceMutationDispatch {
  state: 'dispatched';
  /** Bounded non-sensitive verification binding, not a native command/result dump. */
  verificationToken: string;
}

export interface SystemDeviceMutationVerification {
  state: 'verified' | 'pending' | 'rejected' | 'mismatch' | 'unverified';
  evidence: readonly string[];
}

export interface SystemDeviceBackend {
  readonly platformFamily: string;
  privilegeState(): Promise<SystemDevicePrivilegeState>;
  systemInformation(): Promise<SystemDeviceBackendResult<BoundedSystemInformation>>;
  enumerateDevices(): Promise<SystemDeviceBackendResult<readonly BoundedDeviceMetadata[]>>;
  enumerateVolumes(): Promise<SystemDeviceBackendResult<readonly BoundedVolumeMetadata[]>>;
  observeSystemSetting(scope: SystemSettingScopeIdentity, setting: string): Promise<SystemDeviceBackendResult<SystemSettingObservation>>;
  observeSecuritySetting(scope: SecuritySettingScopeIdentity, setting: string): Promise<SystemDeviceBackendResult<SecuritySettingObservation>>;
  /** Returns the current generation/revision immediately before a mutation. */
  freshMutationBaseline(target: SystemDeviceIdentity, setting: string): Promise<SystemDeviceBackendResult<SystemDeviceMutationBaseline>>;
  /** Called exactly once by this adapter for a newly accepted actionId. */
  dispatchMutation(payload: SystemDeviceMutationPayload, baseline: SystemDeviceMutationBaseline): Promise<SystemDeviceMutationDispatch>;
  verifyMutation(
    payload: SystemDeviceMutationPayload,
    baseline: SystemDeviceMutationBaseline,
    dispatch: SystemDeviceMutationDispatch,
  ): Promise<SystemDeviceMutationVerification>;
}

const MAX_ID_BYTES = 192;
const MAX_LABEL_BYTES = 160;
const MAX_SETTING_BYTES = 128;
const MAX_EVIDENCE = 32;
const SAFE_MACHINE_CODE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const SAFE_SETTING = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const HIGH_RISK_UNSUPPORTED_CAPABILITIES = new Set([
  'device.disk.partition',
  'device.storage.destructive',
  'device.firmware.flash',
  'security.firewall.modify',
  'security.antivirus.modify',
  'security.account.privileged.modify',
]);

export const SYSTEM_DEVICE_CAPABILITIES = [
  'device.observe',
  'system.observe',
  'system.setting.observe',
  'security.setting.observe',
  'system.setting.change',
  'security.setting.change',
  'device.peripheral.configure',
] as const;

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function boundedText(value: string, maxBytes: number): boolean {
  return value.length > 0 && utf8Bytes(value) <= maxBytes && !/[\r\n\0]/.test(value);
}

function validIdentity(identity: SystemDeviceIdentity): boolean {
  return SYSTEM_DEVICE_IDENTITY_KINDS.includes(identity.kind) &&
    boundedText(identity.id, MAX_ID_BYTES) &&
    Number.isSafeInteger(identity.generation) && identity.generation >= 0;
}

function sameIdentity(left: SystemDeviceIdentity, right: SystemDeviceIdentity): boolean {
  return left.id === right.id && left.kind === right.kind && left.generation === right.generation;
}

function validRevision(value: string): boolean {
  return boundedText(value, MAX_ID_BYTES);
}

function validEvidence(evidence: readonly string[]): boolean {
  return evidence.length <= MAX_EVIDENCE && evidence.every((entry) => SAFE_MACHINE_CODE.test(entry));
}

function safeLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return boundedText(value, MAX_LABEL_BYTES) ? value : undefined;
}

function clampNonNegativeSafe(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function boundDevice(device: BoundedDeviceMetadata): BoundedDeviceMetadata | undefined {
  if (!validIdentity(device.identity)) return undefined;
  return {
    identity: { ...device.identity },
    category: device.category,
    presence: device.presence,
    state: device.state,
    label: safeLabel(device.label),
  };
}

function boundVolume(volume: BoundedVolumeMetadata): BoundedVolumeMetadata | undefined {
  if (!validIdentity(volume.identity)) return undefined;
  return {
    identity: { ...volume.identity },
    state: volume.state,
    removable: volume.removable,
    capacityBytes: clampNonNegativeSafe(volume.capacityBytes),
    freeBytes: clampNonNegativeSafe(volume.freeBytes),
    filesystemType: safeLabel(volume.filesystemType),
  };
}

function accessFromFailure(failure: SystemDeviceBackendFailure): SystemDevicePrivilegeState {
  return { state: failure.state, reason: SAFE_MACHINE_CODE.test(failure.evidence) ? failure.evidence : 'backend-access-unavailable' };
}

function actionResult(
  status: ComputerActionResult['status'],
  dispatch: ComputerActionResult['dispatch'],
  verification: ComputerActionResult['verification'],
  evidence: readonly string[],
): ComputerActionResult {
  return {
    status,
    dispatch,
    verification,
    evidence: validEvidence(evidence) ? evidence : ['evidence-redacted'],
  };
}

function requiredEffect(payload: SystemDeviceMutationPayload): Exclude<ComputerEffectClass, 'observe-only'> {
  switch (payload.operation) {
    case 'system-setting-change': return 'system-configuration';
    case 'security-setting-change': return 'security-sensitive';
    case 'peripheral-configuration': return 'hardware-affecting';
  }
}

function operationCapability(operation: SystemDeviceMutationPayload['operation']): string {
  switch (operation) {
    case 'system-setting-change': return 'system.setting.change';
    case 'security-setting-change': return 'security.setting.change';
    case 'peripheral-configuration': return 'device.peripheral.configure';
  }
}

function isMutationPayload(value: unknown): value is SystemDeviceMutationPayload {
  if (!value || typeof value !== 'object') return false;
  const payload = value as Partial<SystemDeviceMutationPayload>;
  if (!['system-setting-change', 'security-setting-change', 'peripheral-configuration'].includes(String(payload.operation))) return false;
  if (!payload.target || !validIdentity(payload.target)) return false;
  if (typeof payload.setting !== 'string' || !SAFE_SETTING.test(payload.setting)) return false;
  if (!['string', 'number', 'boolean'].includes(typeof payload.value)) return false;
  if (typeof payload.value === 'string' && !boundedText(payload.value, 256)) return false;
  if (typeof payload.value === 'number' && !Number.isFinite(payload.value)) return false;
  if (!payload.approval || payload.approval.approved !== true || !validIdentity(payload.approval.target)) return false;
  if (!boundedText(payload.approval.approvalId, MAX_ID_BYTES) || !validRevision(payload.approval.configurationRevision)) return false;
  return true;
}

/**
 * Observation-first environment-neutral adapter for system/device state.
 *
 * It does not contain an OS backend. Production callers must supply a backend
 * explicitly; tests use synthetic backends. Generic `observe()` returns only a
 * bounded system/device snapshot. Typed setting observations are explicit methods
 * so sensitive security state is never silently folded into ordinary traces.
 */
export class SystemDeviceEnvironmentAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor;
  private sequence = 0;
  private readonly actionDispatches = new Map<string, ComputerActionResult>();

  constructor(
    readonly adapterId: string,
    private readonly backend: SystemDeviceBackend,
    options: { enableMutations?: boolean } = {},
  ) {
    this.mutationsEnabled = options.enableMutations === true;
    this.descriptor = Object.freeze({
      id: adapterId,
      kind: 'device' as const,
      version: 'system-device-foundation-v1',
      capabilities: Object.freeze([
        'device.observe',
        'system.observe',
        'system.setting.observe',
        'security.setting.observe',
        ...(this.mutationsEnabled ? ['system.setting.change', 'security.setting.change', 'device.peripheral.configure'] : []),
      ]),
    });
  }

  private readonly mutationsEnabled: boolean;

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    if (request.adapterId !== this.adapterId || request.channel !== 'device') {
      return {
        adapterId: this.adapterId,
        environment: 'device',
        channel: request.channel,
        sequence: this.sequence++,
        complete: false,
        truncated: false,
        data: { access: { state: 'unsupported-platform', reason: 'observation-channel-unsupported' } },
      };
    }

    const maxItems = Math.min(request.limits?.maxItems ?? 64, 256);
    const [access, system, devices, volumes] = await Promise.all([
      this.backend.privilegeState(),
      this.backend.systemInformation(),
      this.backend.enumerateDevices(),
      this.backend.enumerateVolumes(),
    ]);

    const boundedDevices = devices.state === 'ok'
      ? devices.value.map(boundDevice).filter((value): value is BoundedDeviceMetadata => value !== undefined).slice(0, maxItems)
      : [];
    const boundedVolumes = volumes.state === 'ok'
      ? volumes.value.map(boundVolume).filter((value): value is BoundedVolumeMetadata => value !== undefined).slice(0, maxItems)
      : [];
    const unavailable = system.state !== 'ok' ? accessFromFailure(system) :
      devices.state !== 'ok' ? accessFromFailure(devices) :
      volumes.state !== 'ok' ? accessFromFailure(volumes) : undefined;
    const snapshot: SystemDeviceSnapshot = {
      access: unavailable ?? access,
      system: system.state === 'ok' ? {
        platformFamily: safeLabel(system.value.platformFamily) ?? 'unknown',
        architecture: safeLabel(system.value.architecture),
        logicalProcessorCount: clampNonNegativeSafe(system.value.logicalProcessorCount),
        totalMemoryBytes: clampNonNegativeSafe(system.value.totalMemoryBytes),
      } : undefined,
      devices: boundedDevices,
      volumes: boundedVolumes,
    };
    const truncated = (devices.state === 'ok' && devices.value.length > boundedDevices.length) ||
      (volumes.state === 'ok' && volumes.value.length > boundedVolumes.length);
    return {
      adapterId: this.adapterId,
      environment: 'device',
      channel: 'device',
      sequence: this.sequence++,
      complete: !unavailable,
      truncated,
      data: snapshot,
    };
  }

  async observeSystemSetting(scope: SystemSettingScopeIdentity, setting: string): Promise<SystemDeviceBackendResult<SystemSettingObservation>> {
    if (!validIdentity(scope) || !SAFE_SETTING.test(setting)) {
      return { state: 'unsupported-platform', evidence: 'invalid-observation-request' };
    }
    const result = await this.backend.observeSystemSetting(scope, setting);
    if (result.state !== 'ok') return result;
    const value = result.value;
    if (!sameIdentity(value.scope, scope) || value.setting !== setting || !validRevision(value.revision)) {
      return { state: 'unsupported-platform', evidence: 'invalid-backend-observation' };
    }
    return { state: 'ok', value: { ...value, scope: { ...value.scope } } };
  }

  async observeSecuritySetting(scope: SecuritySettingScopeIdentity, setting: string): Promise<SystemDeviceBackendResult<SecuritySettingObservation>> {
    if (!validIdentity(scope) || !SAFE_SETTING.test(setting)) {
      return { state: 'unsupported-platform', evidence: 'invalid-observation-request' };
    }
    const result = await this.backend.observeSecuritySetting(scope, setting);
    if (result.state !== 'ok') return result;
    const value = result.value;
    if (!sameIdentity(value.scope, scope) || value.setting !== setting || !validRevision(value.revision)) {
      return { state: 'unsupported-platform', evidence: 'invalid-backend-observation' };
    }
    return { state: 'ok', value: { ...value, scope: { ...value.scope } } };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    if (request.adapterId !== this.adapterId) {
      return actionResult('unsupported', 'not-dispatched', 'unverified', ['adapter-mismatch']);
    }
    if (HIGH_RISK_UNSUPPORTED_CAPABILITIES.has(request.capability)) {
      return actionResult('unsupported', 'not-dispatched', 'unverified', ['high-risk-operation-unsupported']);
    }
    if (!this.mutationsEnabled) {
      return actionResult('unsupported', 'not-dispatched', 'unverified', ['mutation-disabled']);
    }
    if (!isMutationPayload(request.payload)) {
      return actionResult('rejected', 'not-dispatched', 'unverified', ['mutation-payload-invalid']);
    }
    const payload = request.payload;
    const effect = requiredEffect(payload);
    if (request.capability !== operationCapability(payload.operation) || request.effect !== effect || request.idempotency === 'read-only') {
      return actionResult('rejected', 'not-dispatched', 'unverified', ['risk-classification-mismatch']);
    }
    if (
      payload.approval.effect !== effect ||
      !sameIdentity(payload.approval.target, payload.target)
    ) {
      return actionResult('rejected', 'not-dispatched', 'unverified', ['approval-binding-mismatch']);
    }

    const previous = this.actionDispatches.get(request.actionId);
    if (previous) {
      return actionResult('rejected', previous.dispatch === 'not-dispatched' ? 'not-dispatched' : 'unknown', 'unverified', ['action-id-already-used']);
    }

    const access = await this.backend.privilegeState();
    if (access.state !== 'available') {
      return actionResult('unsupported', 'not-dispatched', 'unverified', [access.reason && SAFE_MACHINE_CODE.test(access.reason) ? access.reason : access.state]);
    }

    const baselineResult = await this.backend.freshMutationBaseline(payload.target, payload.setting);
    if (baselineResult.state !== 'ok') {
      return actionResult('unsupported', 'not-dispatched', 'unverified', [baselineResult.evidence]);
    }
    const baseline = baselineResult.value;
    if (
      !validIdentity(baseline.target) || !sameIdentity(baseline.target, payload.target) ||
      !validRevision(baseline.configurationRevision) ||
      payload.approval.configurationRevision !== baseline.configurationRevision
    ) {
      return actionResult('rejected', 'not-dispatched', 'unverified', ['stale-identity-or-baseline']);
    }

    // Reserve the action ID before dispatch. Any exception after this point is uncertain and never retryable.
    const uncertain = actionResult('unknown', 'unknown', 'unverified', ['dispatch-outcome-uncertain']);
    this.actionDispatches.set(request.actionId, uncertain);
    let dispatch: SystemDeviceMutationDispatch;
    try {
      dispatch = await this.backend.dispatchMutation(payload, baseline);
    } catch {
      return uncertain;
    }
    if (dispatch.state !== 'dispatched' || !boundedText(dispatch.verificationToken, MAX_ID_BYTES)) {
      return uncertain;
    }

    let verification: SystemDeviceMutationVerification;
    try {
      verification = await this.backend.verifyMutation(payload, baseline, dispatch);
    } catch {
      const result = actionResult('unknown', 'dispatched-once', 'unverified', ['verification-failed']);
      this.actionDispatches.set(request.actionId, result);
      return result;
    }
    const evidence = validEvidence(verification.evidence) ? verification.evidence : ['evidence-redacted'];
    const result = verification.state === 'verified'
      ? actionResult('completed', 'dispatched-once', 'verified', evidence)
      : actionResult(
        verification.state === 'rejected' || verification.state === 'mismatch' ? 'rejected' : 'unknown',
        'dispatched-once',
        verification.state,
        evidence,
      );
    this.actionDispatches.set(request.actionId, result);
    return result;
  }

  mayAutoRetry(request: Pick<ComputerActionRequest, 'effect' | 'idempotency'>, result: Pick<ComputerActionResult, 'dispatch'>): boolean {
    return computerActionMayAutoRetry(request, result);
  }
}
