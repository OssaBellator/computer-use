import { createHash } from 'node:crypto';

import type { ComputerUseCapabilityProfile } from './computerUseCapabilityProfiles.js';
import { serializeComputerUseCapabilityProfileCanonical } from './computerUseCapabilityProfileSerialization.js';

/**
 * Stable content fingerprint for a typed computer-use capability profile.
 * The digest is derived only from canonical serialization and therefore binds
 * profile identity, version, kind, capability states, scopes, and notes.
 */
export function fingerprintComputerUseCapabilityProfile(
  profile: ComputerUseCapabilityProfile,
): string {
  const canonical = serializeComputerUseCapabilityProfileCanonical(profile);
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}
