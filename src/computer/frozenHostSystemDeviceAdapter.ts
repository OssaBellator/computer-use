import type { ComputerObservationEnvelope, ComputerObservationRequest } from './environmentAdapter.js';
import {
  type BoundedDeviceMetadata,
  type BoundedSystemInformation,
  type BoundedVolumeMetadata,
  type SystemDevicePrivilegeState,
  type SystemDeviceSnapshot,
} from './systemDeviceAdapter.js';
import {
  TruthfulInventoryLinuxSystemDeviceBackend,
  TruthfulLinuxSystemDeviceEnvironmentAdapter,
} from './truthfulInventoryLinuxSystemDeviceBackend.js';

function frozenAccess(value: SystemDevicePrivilegeState): Readonly<SystemDevicePrivilegeState> {
  return Object.freeze({
    state: value.state,
    ...(value.reason === undefined ? {} : { reason: value.reason }),
  });
}

function frozenSystem(value: BoundedSystemInformation): Readonly<BoundedSystemInformation> {
  return Object.freeze({
    platformFamily: value.platformFamily,
    ...(value.architecture === undefined ? {} : { architecture: value.architecture }),
    ...(value.logicalProcessorCount === undefined ? {} : { logicalProcessorCount: value.logicalProcessorCount }),
    ...(value.totalMemoryBytes === undefined ? {} : { totalMemoryBytes: value.totalMemoryBytes }),
  });
}

function frozenDevice(value: BoundedDeviceMetadata): Readonly<BoundedDeviceMetadata> {
  return Object.freeze({
    identity: Object.freeze({
      id: value.identity.id,
      kind: value.identity.kind,
      generation: value.identity.generation,
    }),
    category: value.category,
    presence: value.presence,
    state: value.state,
    ...(value.label === undefined ? {} : { label: value.label }),
  });
}

function frozenVolume(value: BoundedVolumeMetadata): Readonly<BoundedVolumeMetadata> {
  return Object.freeze({
    identity: Object.freeze({
      id: value.identity.id,
      kind: value.identity.kind,
      generation: value.identity.generation,
    }),
    state: value.state,
    ...(value.removable === undefined ? {} : { removable: value.removable }),
    ...(value.capacityBytes === undefined ? {} : { capacityBytes: value.capacityBytes }),
    ...(value.freeBytes === undefined ? {} : { freeBytes: value.freeBytes }),
    ...(value.filesystemType === undefined ? {} : { filesystemType: value.filesystemType }),
  });
}

function freezeFiniteObservationData(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value;
  const raw = value as Partial<SystemDeviceSnapshot>;
  if (!raw.access) return Object.freeze({});
  const devices = Array.isArray(raw.devices)
    ? Object.freeze(raw.devices.map((device) => frozenDevice(device)))
    : undefined;
  const volumes = Array.isArray(raw.volumes)
    ? Object.freeze(raw.volumes.map((volume) => frozenVolume(volume)))
    : undefined;
  return Object.freeze({
    access: frozenAccess(raw.access),
    ...(raw.system === undefined ? {} : { system: frozenSystem(raw.system) }),
    ...(devices === undefined ? {} : { devices }),
    ...(volumes === undefined ? {} : { volumes }),
  });
}

/**
 * Production host observation adapter that re-copies the reviewed finite device
 * schema and freezes the envelope/data graph before returning it to callers.
 */
export class FrozenTruthfulLinuxSystemDeviceEnvironmentAdapter extends TruthfulLinuxSystemDeviceEnvironmentAdapter {
  constructor(adapterId: string, backend: TruthfulInventoryLinuxSystemDeviceBackend) {
    super(adapterId, backend);
  }

  override async observe(request: ComputerObservationRequest): Promise<ComputerObservationEnvelope> {
    const observed = await super.observe(request);
    return Object.freeze({ ...observed, data: freezeFiniteObservationData(observed.data) });
  }
}
