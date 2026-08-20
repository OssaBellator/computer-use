import {
  COMPUTER_CAPABILITIES,
  type ComputerCapability,
} from './computerCapabilities.js';
import type {
  ComputerCapabilityImplementationState,
  ComputerCapabilityScope,
  ComputerUseCapabilityProfile,
} from './computerUseCapabilityProfiles.js';

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function canonicalState(
  state: ComputerCapabilityImplementationState,
): ComputerCapabilityImplementationState {
  return {
    status: state.status,
    scopes: [...state.scopes].sort(codeUnitCompare) as ComputerCapabilityScope[],
    ...(state.note !== undefined ? { note: state.note } : {}),
  };
}

/**
 * Produce deterministic JSON for a typed capability profile. Capability keys
 * follow taxonomy order and scopes are code-unit sorted, so semantically equal
 * profiles do not depend on caller/object insertion order.
 */
export function serializeComputerUseCapabilityProfileCanonical(
  profile: ComputerUseCapabilityProfile,
): string {
  const capabilities: Partial<Record<ComputerCapability, ComputerCapabilityImplementationState>> = {};

  for (const capability of COMPUTER_CAPABILITIES) {
    if (!Object.prototype.hasOwnProperty.call(profile.capabilities, capability)) continue;
    const state = profile.capabilities[capability];
    if (!state) continue;
    capabilities[capability] = canonicalState(state);
  }

  return JSON.stringify({
    id: profile.id,
    version: profile.version,
    kind: profile.kind,
    capabilities,
  });
}
