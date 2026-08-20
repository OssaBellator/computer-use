import {
  COMPUTER_CAPABILITIES,
  computerCapabilityState,
  type ComputerCapability,
  type ComputerCapabilityProfile,
  type ComputerCapabilityState,
  type ComputerCapabilitySupport,
} from './computerCapabilities.js';

export const COMPUTER_USE_CORE_CAPABILITY_PROFILE: ComputerCapabilityProfile = {
  id: 'computer-use-core-0.2',
  capabilities: {
    'adapter-routing': {
      support: 'supported',
      note: 'ComputerEnvironmentRegistry routes explicit adapter IDs and fails closed on cross-adapter identity mismatch',
    },
    'explicit-confirmation-gate': {
      support: 'supported',
      note: 'ComputerTaskRuntime applies environment-neutral effect approval gates before dispatch for effects that require approval',
    },
    'task-checkpointing': {
      support: 'supported',
      note: 'ComputerTaskRuntime validates execution-bound checkpoints, restores the cursor/action ledger, fails closed on unresolved dispatch, and emits deterministic checkpoints',
    },
    'side-effect-verification': {
      support: 'partial',
      note: 'ComputerTaskRuntime preserves adapter verification state and supports named verifier hooks, but domain/application verification remains adapter- or verifier-specific',
    },
  },
};

const SUPPORT_RANK: Readonly<Record<ComputerCapabilitySupport, number>> = {
  unsupported: 0,
  partial: 1,
  supported: 2,
};

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function strongestState(
  profiles: readonly ComputerCapabilityProfile[],
  capability: ComputerCapability,
): ComputerCapabilityState {
  let support: ComputerCapabilitySupport = 'unsupported';
  const notes = new Set<string>();
  for (const profile of profiles) {
    const state = computerCapabilityState(profile, capability);
    if (SUPPORT_RANK[state.support] > SUPPORT_RANK[support]) support = state.support;
    if (state.note) notes.add(`${profile.id}: ${state.note}`);
  }
  const note = [...notes].sort(codeUnitCompare).join(' | ');
  return { support, ...(note ? { note } : {}) };
}

/**
 * Compose independently scoped core/adapter profiles by availability: the
 * strongest implementation of a capability wins, while notes retain which
 * profile supplied or lacked it. Category assessment remains conservative
 * because capabilities absent from every profile stay unsupported.
 */
export function composeComputerCapabilityProfiles(
  id: string,
  profiles: readonly ComputerCapabilityProfile[],
): ComputerCapabilityProfile {
  if (!id.trim()) throw new Error('computer capability profile id must be non-empty');
  if (profiles.length < 1) throw new Error('at least one computer capability profile is required');
  const capabilities: Partial<Record<ComputerCapability, ComputerCapabilityState>> = {};
  for (const capability of COMPUTER_CAPABILITIES) {
    capabilities[capability] = strongestState(profiles, capability);
  }
  return { id, capabilities };
}
