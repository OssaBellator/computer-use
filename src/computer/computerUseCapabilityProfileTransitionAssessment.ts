import type { ComputerCapability } from './computerCapabilities.js';
import {
  diffComputerUseCapabilityProfiles,
  type ComputerCapabilityProfileDelta,
} from './computerUseCapabilityProfileDiff.js';
import { fingerprintComputerUseCapabilityProfile } from './computerUseCapabilityProfileFingerprint.js';
import { validateComputerUseCapabilityProfileRevisionTransition } from './computerUseCapabilityProfileRevisionPolicy.js';
import { validateComputerUseCapabilityProfileStrict } from './computerUseCapabilityProfileStrictValidation.js';
import { validateComputerUseCapabilityProfileTransition } from './computerUseCapabilityProfileTransitionPolicy.js';
import type { ComputerUseCapabilityProfile } from './computerUseCapabilityProfiles.js';

export interface ComputerUseCapabilityProfileTransitionAssessmentOptions {
  allowHighRiskPromotions?: readonly ComputerCapability[];
}

export interface ComputerUseCapabilityProfileTransitionAssessment {
  beforeFingerprint: string;
  afterFingerprint: string;
  beforeValidationErrors: readonly string[];
  afterValidationErrors: readonly string[];
  deltas: readonly ComputerCapabilityProfileDelta[];
  transitionErrors: readonly string[];
  accepted: boolean;
}

/**
 * Produce one deterministic audit record for a typed profile transition.
 * Structural validity, canonical fingerprints, semantic deltas, stable-version
 * discipline, and high-risk promotion policy are evaluated together without
 * mutating either input profile.
 */
export function assessComputerUseCapabilityProfileTransition(
  before: ComputerUseCapabilityProfile,
  after: ComputerUseCapabilityProfile,
  options: ComputerUseCapabilityProfileTransitionAssessmentOptions = {},
): ComputerUseCapabilityProfileTransitionAssessment {
  const beforeValidationErrors = validateComputerUseCapabilityProfileStrict(before);
  const afterValidationErrors = validateComputerUseCapabilityProfileStrict(after);
  const transitionErrors = Object.freeze([
    ...validateComputerUseCapabilityProfileRevisionTransition(before, after),
    ...validateComputerUseCapabilityProfileTransition(before, after, options),
  ]);

  return Object.freeze({
    beforeFingerprint: fingerprintComputerUseCapabilityProfile(before),
    afterFingerprint: fingerprintComputerUseCapabilityProfile(after),
    beforeValidationErrors,
    afterValidationErrors,
    deltas: diffComputerUseCapabilityProfiles(before, after),
    transitionErrors,
    accepted:
      beforeValidationErrors.length === 0
      && afterValidationErrors.length === 0
      && transitionErrors.length === 0,
  });
}
