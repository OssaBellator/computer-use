import type { ComputerUseCapabilityProfile } from './computerUseCapabilityProfiles.js';
import { serializeComputerUseCapabilityProfileCanonical } from './computerUseCapabilityProfileSerialization.js';

/**
 * A stable profile id/version pair is a semantic contract. If canonical profile
 * content changes while both identity fields remain unchanged, reject the
 * transition so callers must advance the profile version explicitly.
 */
export function validateComputerUseCapabilityProfileRevisionTransition(
  before: ComputerUseCapabilityProfile,
  after: ComputerUseCapabilityProfile,
): readonly string[] {
  if (before.id !== after.id || before.version !== after.version) return Object.freeze([]);
  if (
    serializeComputerUseCapabilityProfileCanonical(before)
    === serializeComputerUseCapabilityProfileCanonical(after)
  ) {
    return Object.freeze([]);
  }
  return Object.freeze([
    `profile.revision.changed-without-version-bump:${before.id}:${before.version}`,
  ]);
}
