import {
  computerActionMayAutoRetry,
  validateComputerActionRequest,
  validateComputerObservationRequest,
  type ComputerActionIdempotency,
  type ComputerActionRequest,
  type ComputerActionResult,
  type ComputerEffectClass,
  type ComputerEnvironmentAdapter,
  type ComputerEnvironmentAdapterDescriptor,
  type ComputerObservationEnvelope,
  type ComputerObservationRequest,
} from './environmentAdapter.js';

export const SYSTEM_DEVICE_IDENTITY_KINDS = [
  'device', 'peripheral', 'volume', 'system-setting-scope', 'security-setting-scope',
] as const;
export type SystemDeviceIdentityKind = typeof SYSTEM_DEVICE_IDENTITY_KINDS[number];

export interface SystemDeviceIdentity<K extends SystemDeviceIdentityKind = SystemDeviceIdentityKind> {
  id: string;
  kind: K;
  generation: number;
}
export type DeviceIdentity = SystemDeviceIdentity<'device' | 'peripheral'>;
export type SystemVolumeIdentity = SystemDeviceIdentity<'volume'>;
export type SystemSettingScopeIdentity = SystemDeviceIdentity<'system-setting-scope'>;
export type SecuritySettingScopeIdentity = SystemDeviceIdentity<'security-setting-scope'>;

export type SystemDeviceAccessState =
  | 'available' | 'unsupported-platform' | 'unsupported-privilege' | 'permission-denied';

export interface SystemDevicePrivilegeState {
  state: SystemDeviceAccessState;
  reason?: string;
}
export type DevicePresence = 'present' | 'absent' | 'unknown';
export type DeviceOperationalState = 'ready' | 'busy' | 'disabled' | 'degraded' | 'unknown';

export interface BoundedDeviceMetadata {
  identity: DeviceIdentity;
  category: 'display' | 'input' | 'audio' | 'camera' | 'printer' | 'storage' | 'network' | 'other';
  presence: DevicePresence;
  state: DeviceOperationalState;
  label?: string;
}
export interface BoundedVolumeMetadata {
  identity: SystemVolumeIdentity;
  state: 'online' | 'offline' | 'read-only' | 'unknown';
  removable?: boolean;
  capacityBytes?: number;
  freeBytes?: number;
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
  value?: string | number | boolean;
  revision: string;
}
export interface SecuritySettingObservation {
  scope: SecuritySettingScopeIdentity;
  setting: string;
  state: 'known' | 'unsupported' | 'permission-denied' | 'unknown';
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
export type SystemDeviceBackendResult<T> = { state: 'ok'; value: T } | SystemDeviceBackendFailure;

export interface SystemDeviceMutationBaseline {
  target: SystemDeviceIdentity;
  configurationRevision: string;
}
export interface SystemDeviceMutationApproval {
  approved: true;
  approvalId: string;
  effect: Exclude<ComputerEffectClass, 'observe-only'>;
  target: SystemDeviceIdentity;
  configurationRevision: string;
}
export interface SystemDeviceMutationPayload {
  operation: 'system-setting-change' | 'security-setting-change' | 'peripheral-configuration';
  target: SystemDeviceIdentity;
  setting: string;
  value: string | number | boolean;
  approval: SystemDeviceMutationApproval;
}
export interface SystemDeviceMutationDispatch {
  state: 'dispatched';
  verificationToken: string;
}
export interface SystemDeviceMutationVerification {
  state: 'verified' | 'pending' | 'rejected' | 'mismatch' | 'unverified';
  evidence: readonly string[];
}

export interface SystemDeviceApprovalVerifier {
  verify(
    request: Readonly<Pick<ComputerActionRequest, 'actionId' | 'capability' | 'effect'>>,
    payload: Readonly<SystemDeviceMutationPayload>,
  ): Promise<boolean>;
}

/**
 * Exactly-once integration seam. Production implementations can use bounded durable
 * storage with their own retention policy. `claim` must atomically reject a reused
 * action ID, including IDs whose earlier dispatch outcome was uncertain.
 */
export interface SystemDeviceActionLedger {
  claim(actionId: string): Promise<'claimed' | 'already-used' | 'unavailable'>;
  record(actionId: string, result: Readonly<ComputerActionResult>): Promise<void>;
}

/**
 * Acquisition budget passed into backend enumeration. Backends must not materialize
 * more than maxItems entries and should keep dynamic text acquisition within
 * maxTextBytes. The adapter also rejects an over-limit returned collection before
 * iterating it.
 */
export interface SystemDeviceEnumerationBudget {
  readonly maxItems: number;
  readonly maxTextBytes: number;
}

export interface SystemDeviceBackend {
  readonly platformFamily: string;
  privilegeState(): Promise<SystemDevicePrivilegeState>;
  systemInformation(): Promise<SystemDeviceBackendResult<BoundedSystemInformation>>;
  enumerateDevices(budget: Readonly<SystemDeviceEnumerationBudget>): Promise<SystemDeviceBackendResult<readonly BoundedDeviceMetadata[]>>;
  enumerateVolumes(budget: Readonly<SystemDeviceEnumerationBudget>): Promise<SystemDeviceBackendResult<readonly BoundedVolumeMetadata[]>>;
  observeSystemSetting(scope: SystemSettingScopeIdentity, setting: string): Promise<SystemDeviceBackendResult<SystemSettingObservation>>;
  observeSecuritySetting(scope: SecuritySettingScopeIdentity, setting: string): Promise<SystemDeviceBackendResult<SecuritySettingObservation>>;
  freshMutationBaseline(target: SystemDeviceIdentity, setting: string): Promise<SystemDeviceBackendResult<SystemDeviceMutationBaseline>>;
  dispatchMutation(payload: SystemDeviceMutationPayload, baseline: SystemDeviceMutationBaseline): Promise<SystemDeviceMutationDispatch>;
  verifyMutation(
    payload: SystemDeviceMutationPayload,
    baseline: SystemDeviceMutationBaseline,
    dispatch: SystemDeviceMutationDispatch,
  ): Promise<SystemDeviceMutationVerification>;
}

const MAX_ID_BYTES = 192;
const MAX_LABEL_BYTES = 160;
const MAX_VALUE_BYTES = 256;
const MAX_EVIDENCE = 32;
const MAX_ENUMERATION_ITEMS = 256;
const MAX_ENUMERATION_TEXT_BYTES = 65_536;
const SAFE_MACHINE_CODE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;
const SAFE_SETTING = /^[a-z0-9][a-z0-9._:-]{0,127}$/;
const SYSTEM_STATES = new Set(['known', 'unsupported', 'permission-denied', 'unknown']);
const SECURITY_VALUES = new Set(['enabled', 'disabled', 'managed', 'not-configured', 'unknown']);
const HIGH_RISK_UNSUPPORTED_CAPABILITIES = new Set([
  'device.disk.partition',
  'device.storage.destructive',
  'device.firmware.flash',
  'security.firewall.modify',
  'security.antivirus.modify',
  'security.account.privileged.modify',
]);

/** Complete capability vocabulary for this domain; descriptors only advertise neutral-interface-routable capabilities. */
export const SYSTEM_DEVICE_CAPABILITIES = [
  'device.observe',
  'system.observe',
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
function cloneIdentity<T extends SystemDeviceIdentity>(identity: T): T {
  return Object.freeze({ id: identity.id, kind: identity.kind, generation: identity.generation }) as T;
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
function safeMachineCode(value: string | undefined, fallback: string): string {
  return value !== undefined && SAFE_MACHINE_CODE.test(value) ? value : fallback;
}
function sanitizePrivilege(value: SystemDevicePrivilegeState): SystemDevicePrivilegeState {
  return {
    state: ['available', 'unsupported-platform', 'unsupported-privilege', 'permission-denied'].includes(value.state)
      ? value.state : 'unsupported-platform',
    ...(value.reason ? { reason: safeMachineCode(value.reason, 'backend-access-unavailable') } : {}),
  };
}
function safeLabel(value: string | undefined): string | undefined {
  return value !== undefined && boundedText(value, MAX_LABEL_BYTES) ? value : undefined;
}
function safeScalar(value: unknown): string | number | boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return boundedText(value, MAX_VALUE_BYTES) ? value : undefined;
  return undefined;
}
function clampNonNegativeSafe(value: number | undefined): number | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function boundDevice(device: BoundedDeviceMetadata): BoundedDeviceMetadata | undefined {
  if (!validIdentity(device.identity)) return undefined;
  return {
    identity: cloneIdentity(device.identity), category: device.category, presence: device.presence,
    state: device.state, label: safeLabel(device.label),
  };
}
function boundVolume(volume: BoundedVolumeMetadata): BoundedVolumeMetadata | undefined {
  if (!validIdentity(volume.identity)) return undefined;
  return {
    identity: cloneIdentity(volume.identity), state: volume.state, removable: volume.removable,
    capacityBytes: clampNonNegativeSafe(volume.capacityBytes),
    freeBytes: clampNonNegativeSafe(volume.freeBytes),
    filesystemType: safeLabel(volume.filesystemType),
  };
}
function accessFromFailure(failure: SystemDeviceBackendFailure): SystemDevicePrivilegeState {
  return { state: failure.state, reason: safeMachineCode(failure.evidence, 'backend-access-unavailable') };
}
function actionResult(
  status: ComputerActionResult['status'],
  dispatch: ComputerActionResult['dispatch'],
  verification: ComputerActionResult['verification'],
  evidence: readonly string[],
): ComputerActionResult {
  return { status, dispatch, verification, evidence: validEvidence(evidence) ? evidence : ['evidence-redacted'] };
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

function snapshotOwnDataProperties(
  value: unknown,
  requiredKeys: readonly string[],
): Readonly<Record<string, unknown>> | undefined {
  if (!value || typeof value !== 'object') return undefined;
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return undefined;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const captured: Record<string, unknown> = {};
    for (const key of requiredKeys) {
      const descriptor = descriptors[key];
      if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) return undefined;
      captured[key] = descriptor.value;
    }
    return Object.freeze(captured);
  } catch {
    return undefined;
  }
}

function snapshotIdentity(value: unknown): Readonly<SystemDeviceIdentity> | undefined {
  const captured = snapshotOwnDataProperties(value, ['id', 'kind', 'generation']);
  if (!captured) return undefined;
  const id = captured.id;
  const kind = captured.kind;
  const generation = captured.generation;
  if (typeof id !== 'string' || !boundedText(id, MAX_ID_BYTES)) return undefined;
  if (typeof kind !== 'string' || !SYSTEM_DEVICE_IDENTITY_KINDS.includes(kind as SystemDeviceIdentityKind)) return undefined;
  if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation < 0) return undefined;
  return Object.freeze({ id, kind: kind as SystemDeviceIdentityKind, generation });
}

/**
 * Rebuild caller-owned mutation input before the first await. Each accepted field
 * is captured exactly once from an ordinary own data descriptor; accessors and
 * non-plain object shapes fail closed before approval or backend work.
 */
function snapshotMutationPayload(value: unknown): Readonly<SystemDeviceMutationPayload> | undefined {
  const captured = snapshotOwnDataProperties(value, ['operation', 'target', 'setting', 'value', 'approval']);
  if (!captured) return undefined;

  const operation = captured.operation;
  if (operation !== 'system-setting-change' &&
      operation !== 'security-setting-change' &&
      operation !== 'peripheral-configuration') return undefined;
  const target = snapshotIdentity(captured.target);
  if (!target) return undefined;
  const setting = captured.setting;
  if (typeof setting !== 'string' || !SAFE_SETTING.test(setting)) return undefined;
  const scalar = safeScalar(captured.value);
  if (scalar === undefined) return undefined;

  const approvalCaptured = snapshotOwnDataProperties(
    captured.approval,
    ['approved', 'approvalId', 'effect', 'target', 'configurationRevision'],
  );
  if (!approvalCaptured || approvalCaptured.approved !== true) return undefined;
  const approvalId = approvalCaptured.approvalId;
  const approvalEffect = approvalCaptured.effect;
  const configurationRevision = approvalCaptured.configurationRevision;
  if (typeof approvalId !== 'string' || !boundedText(approvalId, MAX_ID_BYTES)) return undefined;
  if (approvalEffect !== 'system-configuration' &&
      approvalEffect !== 'security-sensitive' &&
      approvalEffect !== 'hardware-affecting') return undefined;
  if (typeof configurationRevision !== 'string' || !validRevision(configurationRevision)) return undefined;
  const approvalTarget = snapshotIdentity(approvalCaptured.target);
  if (!approvalTarget) return undefined;

  const approval: Readonly<SystemDeviceMutationApproval> = Object.freeze({
    approved: true,
    approvalId,
    effect: approvalEffect,
    target: approvalTarget as SystemDeviceIdentity,
    configurationRevision,
  });
  return Object.freeze({
    operation,
    target: target as SystemDeviceIdentity,
    setting,
    value: scalar,
    approval: approval as SystemDeviceMutationApproval,
  });
}

function neutralTargetMatchesPayload(
  request: ComputerActionRequest,
  payloadTarget: Readonly<SystemDeviceIdentity>,
): boolean {
  const target = request.target;
  return target !== undefined &&
    target.adapterId === request.adapterId &&
    target.environment === 'device' &&
    target.kind === payloadTarget.kind &&
    target.entityId === payloadTarget.id &&
    target.generation === payloadTarget.generation &&
    target.surfaceId === undefined;
}

interface TextBudget {
  remaining: number;
  truncated: boolean;
}
function consumeText(value: string | undefined, budget: TextBudget): string | undefined {
  if (value === undefined) return undefined;
  const bytes = utf8Bytes(value);
  if (bytes > budget.remaining) {
    budget.truncated = true;
    return undefined;
  }
  budget.remaining -= bytes;
  return value;
}

interface ActionSnapshot {
  readonly actionId: string;
  readonly capability: string;
  readonly effect: ComputerEffectClass;
  readonly idempotency: ComputerActionIdempotency;
}

export class SystemDeviceEnvironmentAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor: ComputerEnvironmentAdapterDescriptor;
  private sequence = 0;
  private readonly mutationsEnabled: boolean;
  private readonly approvalVerifier?: SystemDeviceApprovalVerifier;
  private readonly actionLedger?: SystemDeviceActionLedger;

  constructor(
    readonly adapterId: string,
    private readonly backend: SystemDeviceBackend,
    options: {
      enableMutations?: boolean;
      approvalVerifier?: SystemDeviceApprovalVerifier;
      actionLedger?: SystemDeviceActionLedger;
    } = {},
  ) {
    this.approvalVerifier = options.approvalVerifier;
    this.actionLedger = options.actionLedger;
    this.mutationsEnabled = options.enableMutations === true &&
      this.approvalVerifier !== undefined && this.actionLedger !== undefined;
    this.descriptor = Object.freeze({
      id: adapterId,
      kind: 'device' as const,
      version: 'system-device-foundation-v6',
      capabilities: Object.freeze([
        'device.observe',
        'system.observe',
        ...(this.mutationsEnabled ? ['system.setting.change', 'security.setting.change', 'device.peripheral.configure'] : []),
      ]),
    });
  }

  async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    const requestErrors = validateComputerObservationRequest(request, this.descriptor);
    if (requestErrors.length > 0 || request.adapterId !== this.adapterId || request.channel !== 'device') {
      return {
        adapterId: this.adapterId, environment: 'device', channel: request.channel,
        sequence: this.sequence++, complete: false, truncated: false,
        data: { access: { state: 'unsupported-platform', reason: 'invalid-observation-request' } },
      };
    }

    const maxItems = Math.min(request.limits?.maxItems ?? 64, MAX_ENUMERATION_ITEMS);
    const textBudget: TextBudget = {
      remaining: Math.min(request.limits?.maxTextBytes ?? 16_384, MAX_ENUMERATION_TEXT_BYTES),
      truncated: false,
    };

    const [rawAccess, system] = await Promise.all([
      this.backend.privilegeState(),
      this.backend.systemInformation(),
    ]);
    const access = sanitizePrivilege(rawAccess);
    const boundedAccess: SystemDevicePrivilegeState = {
      state: access.state,
      reason: consumeText(access.reason, textBudget),
    };

    let remainingItems = maxItems;
    const deviceBudget: SystemDeviceEnumerationBudget = Object.freeze({
      maxItems: remainingItems,
      maxTextBytes: textBudget.remaining,
    });
    const devices = await this.backend.enumerateDevices(deviceBudget);
    if (devices.state === 'ok' && (!Array.isArray(devices.value) || devices.value.length > deviceBudget.maxItems)) {
      return {
        adapterId: this.adapterId, environment: 'device', channel: 'device',
        sequence: this.sequence++, complete: false, truncated: true,
        data: {
          access: { state: 'unsupported-platform', reason: 'invalid-backend-observation' },
          devices: [], volumes: [],
        },
      };
    }

    const unavailableAfterDevices = system.state !== 'ok' ? accessFromFailure(system) :
      devices.state !== 'ok' ? accessFromFailure(devices) : undefined;
    const boundedDevices: BoundedDeviceMetadata[] = [];
    if (devices.state === 'ok') {
      remainingItems -= devices.value.length;
      for (const raw of devices.value) {
        const bounded = boundDevice(raw);
        if (!bounded) { textBudget.truncated = true; continue; }
        bounded.label = consumeText(bounded.label, textBudget);
        boundedDevices.push(bounded);
      }
    }

    let volumes: SystemDeviceBackendResult<readonly BoundedVolumeMetadata[]> = { state: 'ok', value: [] };
    if (remainingItems > 0) {
      const volumeBudget: SystemDeviceEnumerationBudget = Object.freeze({
        maxItems: remainingItems,
        maxTextBytes: textBudget.remaining,
      });
      volumes = await this.backend.enumerateVolumes(volumeBudget);
      if (volumes.state === 'ok' && (!Array.isArray(volumes.value) || volumes.value.length > volumeBudget.maxItems)) {
        return {
          adapterId: this.adapterId, environment: 'device', channel: 'device',
          sequence: this.sequence++, complete: false, truncated: true,
          data: {
            access: { state: 'unsupported-platform', reason: 'invalid-backend-observation' },
            devices: boundedDevices, volumes: [],
          },
        };
      }
    } else {
      textBudget.truncated = true;
    }

    const unavailable = unavailableAfterDevices ??
      (volumes.state !== 'ok' ? accessFromFailure(volumes) : undefined);
    const chosenAccess = unavailable ?? boundedAccess;
    const finalAccess: SystemDevicePrivilegeState = {
      state: chosenAccess.state,
      reason: chosenAccess === boundedAccess
        ? boundedAccess.reason
        : consumeText(chosenAccess.reason, textBudget),
    };

    const boundedVolumes: BoundedVolumeMetadata[] = [];
    if (volumes.state === 'ok') {
      remainingItems -= volumes.value.length;
      for (const raw of volumes.value) {
        const bounded = boundVolume(raw);
        if (!bounded) { textBudget.truncated = true; continue; }
        bounded.filesystemType = consumeText(bounded.filesystemType, textBudget);
        boundedVolumes.push(bounded);
      }
    }

    let boundedSystem: BoundedSystemInformation | undefined;
    if (system.state === 'ok') {
      const platformFamily = consumeText(safeLabel(system.value.platformFamily), textBudget);
      if (platformFamily !== undefined) {
        boundedSystem = {
          platformFamily,
          architecture: consumeText(safeLabel(system.value.architecture), textBudget),
          logicalProcessorCount: clampNonNegativeSafe(system.value.logicalProcessorCount),
          totalMemoryBytes: clampNonNegativeSafe(system.value.totalMemoryBytes),
        };
      } else {
        textBudget.truncated = true;
      }
    }

    return {
      adapterId: this.adapterId, environment: 'device', channel: 'device',
      sequence: this.sequence++, complete: !unavailable, truncated: textBudget.truncated,
      data: { access: finalAccess, system: boundedSystem, devices: boundedDevices, volumes: boundedVolumes } satisfies SystemDeviceSnapshot,
    };
  }

  /** Typed observation helper; not advertised until neutral setting-scope routing exists. */
  async observeSystemSetting(scope: SystemSettingScopeIdentity, setting: string): Promise<SystemDeviceBackendResult<SystemSettingObservation>> {
    if (!validIdentity(scope) || !SAFE_SETTING.test(setting)) {
      return { state: 'unsupported-platform', evidence: 'invalid-observation-request' };
    }
    const result = await this.backend.observeSystemSetting(scope, setting);
    if (result.state !== 'ok') {
      return { state: result.state, evidence: safeMachineCode(result.evidence, 'backend-access-unavailable') };
    }
    const value = result.value;
    const scalar = safeScalar(value.value);
    if (!sameIdentity(value.scope, scope) || value.setting !== setting || !validRevision(value.revision) ||
        !SYSTEM_STATES.has(value.state) || (value.value !== undefined && scalar === undefined)) {
      return { state: 'unsupported-platform', evidence: 'invalid-backend-observation' };
    }
    return {
      state: 'ok',
      value: { scope: cloneIdentity(scope), setting, state: value.state, value: scalar, revision: value.revision },
    };
  }

  /** Typed coarse security observation helper; not advertised until neutral scope routing exists. */
  async observeSecuritySetting(scope: SecuritySettingScopeIdentity, setting: string): Promise<SystemDeviceBackendResult<SecuritySettingObservation>> {
    if (!validIdentity(scope) || !SAFE_SETTING.test(setting)) {
      return { state: 'unsupported-platform', evidence: 'invalid-observation-request' };
    }
    const result = await this.backend.observeSecuritySetting(scope, setting);
    if (result.state !== 'ok') {
      return { state: result.state, evidence: safeMachineCode(result.evidence, 'backend-access-unavailable') };
    }
    const value = result.value;
    if (!sameIdentity(value.scope, scope) || value.setting !== setting || !validRevision(value.revision) ||
        !SYSTEM_STATES.has(value.state) || (value.value !== undefined && !SECURITY_VALUES.has(value.value))) {
      return { state: 'unsupported-platform', evidence: 'invalid-backend-observation' };
    }
    return {
      state: 'ok',
      value: { scope: cloneIdentity(scope), setting, state: value.state, value: value.value, revision: value.revision },
    };
  }

  async act(request: ComputerActionRequest): Promise<ComputerActionResult> {
    const requestErrors = validateComputerActionRequest(request, this.descriptor);
    if (requestErrors.length > 0) {
      return actionResult('rejected', 'not-dispatched', 'unverified', ['invalid-action-request']);
    }
    if (request.adapterId !== this.adapterId) {
      return actionResult('unsupported', 'not-dispatched', 'unverified', ['adapter-mismatch']);
    }
    if (HIGH_RISK_UNSUPPORTED_CAPABILITIES.has(request.capability)) {
      return actionResult('unsupported', 'not-dispatched', 'unverified', ['high-risk-operation-unsupported']);
    }
    if (!this.mutationsEnabled || !this.approvalVerifier || !this.actionLedger) {
      return actionResult('unsupported', 'not-dispatched', 'unverified', ['mutation-disabled']);
    }

    const payload = snapshotMutationPayload(request.payload);
    if (!payload) {
      return actionResult('rejected', 'not-dispatched', 'unverified', ['mutation-payload-invalid']);
    }
    if (!neutralTargetMatchesPayload(request, payload.target)) {
      return actionResult('rejected', 'not-dispatched', 'unverified', ['mutation-target-binding-mismatch']);
    }
    const action: ActionSnapshot = Object.freeze({
      actionId: request.actionId,
      capability: request.capability,
      effect: request.effect,
      idempotency: request.idempotency,
    });
    const effect = requiredEffect(payload);
    if (action.capability !== operationCapability(payload.operation) || action.effect !== effect || action.idempotency === 'read-only') {
      return actionResult('rejected', 'not-dispatched', 'unverified', ['risk-classification-mismatch']);
    }
    if (payload.approval.effect !== effect || !sameIdentity(payload.approval.target, payload.target)) {
      return actionResult('rejected', 'not-dispatched', 'unverified', ['approval-binding-mismatch']);
    }

    let trustedApproval = false;
    try {
      trustedApproval = await this.approvalVerifier.verify(
        Object.freeze({ actionId: action.actionId, capability: action.capability, effect: action.effect }),
        payload,
      );
    } catch {
      return actionResult('rejected', 'not-dispatched', 'unverified', ['approval-verification-unavailable']);
    }
    if (!trustedApproval) {
      return actionResult('rejected', 'not-dispatched', 'unverified', ['approval-not-trusted']);
    }

    const access = sanitizePrivilege(await this.backend.privilegeState());
    if (access.state !== 'available') {
      return actionResult('unsupported', 'not-dispatched', 'unverified', [
        access.reason ?? safeMachineCode(access.state, 'backend-access-unavailable'),
      ]);
    }
    const baselineResult = await this.backend.freshMutationBaseline(payload.target, payload.setting);
    if (baselineResult.state !== 'ok') {
      return actionResult('unsupported', 'not-dispatched', 'unverified', [
        safeMachineCode(baselineResult.evidence, 'backend-access-unavailable'),
      ]);
    }
    const rawBaseline = baselineResult.value;
    if (!validIdentity(rawBaseline.target) || !validRevision(rawBaseline.configurationRevision)) {
      return actionResult('rejected', 'not-dispatched', 'unverified', ['stale-identity-or-baseline']);
    }
    const baseline: Readonly<SystemDeviceMutationBaseline> = Object.freeze({
      target: cloneIdentity(rawBaseline.target),
      configurationRevision: rawBaseline.configurationRevision,
    });
    if (!sameIdentity(baseline.target, payload.target) ||
        payload.approval.configurationRevision !== baseline.configurationRevision) {
      return actionResult('rejected', 'not-dispatched', 'unverified', ['stale-identity-or-baseline']);
    }

    let claim: Awaited<ReturnType<SystemDeviceActionLedger['claim']>>;
    try {
      claim = await this.actionLedger.claim(action.actionId);
    } catch {
      claim = 'unavailable';
    }
    if (claim === 'already-used') {
      return actionResult('rejected', 'unknown', 'unverified', ['action-id-already-used']);
    }
    if (claim !== 'claimed') {
      return actionResult('rejected', 'not-dispatched', 'unverified', ['action-ledger-unavailable']);
    }

    const uncertain = actionResult('unknown', 'unknown', 'unverified', ['dispatch-outcome-uncertain']);
    let dispatch: SystemDeviceMutationDispatch;
    try {
      dispatch = await this.backend.dispatchMutation(payload as SystemDeviceMutationPayload, baseline as SystemDeviceMutationBaseline);
    } catch {
      await this.recordBestEffort(action.actionId, uncertain);
      return uncertain;
    }
    if (dispatch.state !== 'dispatched' || !boundedText(dispatch.verificationToken, MAX_ID_BYTES)) {
      await this.recordBestEffort(action.actionId, uncertain);
      return uncertain;
    }

    let verification: SystemDeviceMutationVerification;
    try {
      verification = await this.backend.verifyMutation(
        payload as SystemDeviceMutationPayload,
        baseline as SystemDeviceMutationBaseline,
        dispatch,
      );
    } catch {
      const result = actionResult('unknown', 'dispatched-once', 'unverified', ['verification-failed']);
      await this.recordBestEffort(action.actionId, result);
      return result;
    }
    const evidence = validEvidence(verification.evidence) ? verification.evidence : ['evidence-redacted'];
    const result = verification.state === 'verified'
      ? actionResult('completed', 'dispatched-once', 'verified', evidence)
      : actionResult(
          verification.state === 'rejected' || verification.state === 'mismatch' ? 'rejected' : 'unknown',
          'dispatched-once', verification.state, evidence,
        );
    await this.recordBestEffort(action.actionId, result);
    return result;
  }

  private async recordBestEffort(actionId: string, result: ComputerActionResult): Promise<void> {
    try { await this.actionLedger?.record(actionId, result); } catch { /* claim remains the safety boundary */ }
  }

  mayAutoRetry(
    request: Pick<ComputerActionRequest, 'effect' | 'idempotency'>,
    result: Pick<ComputerActionResult, 'dispatch'>,
  ): boolean {
    return computerActionMayAutoRetry(request, result);
  }
}
