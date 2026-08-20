import type { ComputerCapability } from './computerCapabilities.js';
import type {
  ComputerCapabilityImplementationState,
  ComputerUseCapabilityProfile,
} from './computerUseCapabilityProfiles.js';
import {
  validateComputerUseCapabilityProfileSnapshot,
  type ComputerUseCapabilityProfileSnapshotValidationOptions,
} from './computerUseCapabilityProfileSnapshotValidation.js';

/**
 * Validate, copy, and deeply freeze an unknown serialized capability profile so
 * runtime/model consumers never retain caller-owned mutable profile state.
 */
export function snapshotComputerUseCapabilityProfile(
  value: unknown,
  options: ComputerUseCapabilityProfileSnapshotValidationOptions = {},
): ComputerUseCapabilityProfile {
  const errors = validateComputerUseCapabilityProfileSnapshot(value, options);
  if (errors.length > 0) {
    throw new Error(`invalid computer-use capability profile snapshot: ${errors.join(',')}`);
  }

  const raw = value as ComputerUseCapabilityProfile;
  const capabilities: Partial<Record<ComputerCapability, ComputerCapabilityImplementationState>> = {};

  for (const [capability, state] of Object.entries(raw.capabilities) as Array<[
    ComputerCapability,
    ComputerCapabilityImplementationState,
  ]>) {
    capabilities[capability] = Object.freeze({
      status: state.status,
      scopes: Object.freeze([...state.scopes]),
      ...(state.note !== undefined ? { note: state.note } : {}),
    });
  }

  return Object.freeze({
    id: raw.id,
    version: raw.version,
    kind: raw.kind,
    capabilities: Object.freeze(capabilities),
  });
}
