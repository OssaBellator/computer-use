import type { ComputerCapability } from './computerCapabilities.js';
import {
  findHighRiskComputerCapabilityPromotions,
} from './computerUseCapabilityProfileDiff.js';
import type { ComputerUseCapabilityProfile } from './computerUseCapabilityProfiles.js';

export interface ComputerUseCapabilityProfileTransitionPolicyOptions {
  allowHighRiskPromotions?: readonly ComputerCapability[];
}

/**
 * Validate policy-sensitive profile transitions. High-risk capability
 * promotions are rejected by default and must be explicitly allowlisted by
 * capability name at the call site that is reviewing the transition.
 */
export function validateComputerUseCapabilityProfileTransition(
  before: ComputerUseCapabilityProfile,
  after: ComputerUseCapabilityProfile,
  options: ComputerUseCapabilityProfileTransitionPolicyOptions = {},
): readonly string[] {
  const allowed = new Set(options.allowHighRiskPromotions ?? []);
  const errors = findHighRiskComputerCapabilityPromotions(before, after)
    .filter((delta) => !allowed.has(delta.capability))
    .map((delta) => (
      `high-risk-capability.promotion:${delta.capability}:${delta.beforeStatus}->${delta.afterStatus}`
    ));
  return Object.freeze(errors);
}
