import type { ComputerCapability } from './computerCapabilities.js';
import type {
  ComputerCapabilityImplementationStatus,
  ComputerCapabilityScope,
  ComputerUseCapabilityProfile,
} from './computerUseCapabilityProfiles.js';

export interface ComputerCapabilityScopeEvidence {
  scope: ComputerCapabilityScope;
  status: ComputerCapabilityImplementationStatus;
  profileIds: readonly string[];
  notes: readonly string[];
}

const STATUS_RANK: Readonly<Record<ComputerCapabilityImplementationStatus, number>> = {
  unsupported: 0,
  'backend-required': 1,
  'implemented-foundation': 2,
  partial: 3,
  implemented: 4,
};

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Collect capability evidence per environment scope without flattening away
 * explicit unsupported/backend-required states from individual components.
 *
 * The integrated profile intentionally answers "what is the strongest source
 * behavior anywhere?". This helper answers the different question "what does
 * source claim in each scope?", which prevents a union of provenance scopes
 * from being mistaken for universal support.
 */
export function collectComputerCapabilityScopeEvidence(
  capability: ComputerCapability,
  profiles: readonly ComputerUseCapabilityProfile[],
): readonly ComputerCapabilityScopeEvidence[] {
  const byScope = new Map<ComputerCapabilityScope, {
    status: ComputerCapabilityImplementationStatus;
    profileIds: Set<string>;
    notes: Set<string>;
  }>();

  for (const profile of profiles) {
    const state = profile.capabilities[capability];
    if (!state) continue;

    for (const scope of state.scopes) {
      const current = byScope.get(scope);
      if (!current) {
        byScope.set(scope, {
          status: state.status,
          profileIds: new Set([profile.id]),
          notes: new Set(state.note ? [state.note] : []),
        });
        continue;
      }

      if (STATUS_RANK[state.status] > STATUS_RANK[current.status]) current.status = state.status;
      current.profileIds.add(profile.id);
      if (state.note) current.notes.add(state.note);
    }
  }

  return Object.freeze(
    [...byScope.entries()]
      .sort(([left], [right]) => codeUnitCompare(left, right))
      .map(([scope, evidence]) => Object.freeze({
        scope,
        status: evidence.status,
        profileIds: Object.freeze([...evidence.profileIds].sort(codeUnitCompare)),
        notes: Object.freeze([...evidence.notes].sort(codeUnitCompare)),
      })),
  );
}
