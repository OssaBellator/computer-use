import type { ComputerCapability } from './computerCapabilities.js';
import {
  validateComputerUseCapabilityProfile,
  type ComputerUseCapabilityProfile,
} from './computerUseCapabilityProfiles.js';

export interface ComputerUseCapabilityProfileStrictValidationOptions {
  requireComplete?: boolean;
  requireExplicitHighRisk?: boolean;
}

/**
 * Strengthen the typed profile validator with invariants that TypeScript types
 * cannot express, while preserving the existing validator's error codes and
 * options. In particular, a capability may name a scope at most once.
 */
export function validateComputerUseCapabilityProfileStrict(
  profile: ComputerUseCapabilityProfile,
  options: ComputerUseCapabilityProfileStrictValidationOptions = {},
): readonly string[] {
  const errors = [...validateComputerUseCapabilityProfile(profile, options)];

  for (const [capability, state] of Object.entries(profile.capabilities) as Array<[
    ComputerCapability,
    NonNullable<ComputerUseCapabilityProfile['capabilities'][ComputerCapability]>,
  ]>) {
    if (!state) continue;
    const seen = new Set<string>();
    for (const scope of state.scopes) {
      if (seen.has(scope)) errors.push(`capability.scope.duplicate:${capability}:${scope}`);
      seen.add(scope);
    }
  }

  return Object.freeze(errors);
}
