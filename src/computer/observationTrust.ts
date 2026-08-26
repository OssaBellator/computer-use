export const OBSERVATION_TRUST_CLASSES = [
  'user-authored',
  'host-policy',
  'trusted-application-state',
  'external-untrusted-content',
  'agent-derived',
] as const;

export type ObservationTrustClass = typeof OBSERVATION_TRUST_CLASSES[number];

export interface ObservationTrust {
  readonly classification: ObservationTrustClass;
  /** Whether this observation is allowed to contribute instruction authority. */
  readonly instructionAuthority: boolean;
  /** Stable, bounded provenance labels. Payload/content must not be stored here. */
  readonly provenance: readonly string[];
  /** True when any source in the derivation chain was externally supplied untrusted content. */
  readonly containsExternalUntrustedContent: boolean;
}

const MAX_PROVENANCE = 16;
const PROVENANCE_PATTERN = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

function boundedProvenance(values: readonly string[]): readonly string[] {
  const out: string[] = [];
  for (const value of values) {
    if (out.length >= MAX_PROVENANCE) break;
    if (!PROVENANCE_PATTERN.test(value) || out.includes(value)) continue;
    out.push(value);
  }
  return Object.freeze(out);
}

export function observationTrust(
  classification: ObservationTrustClass,
  provenance: readonly string[] = [],
): ObservationTrust {
  if (!OBSERVATION_TRUST_CLASSES.includes(classification)) throw new Error('unsupported observation trust classification');
  return Object.freeze({
    classification,
    instructionAuthority: classification === 'user-authored' || classification === 'host-policy',
    provenance: boundedProvenance(provenance),
    containsExternalUntrustedContent: classification === 'external-untrusted-content',
  });
}

/**
 * Derive a new observation without allowing summarization, graph insertion, RAG,
 * or model interpretation to amplify authority from its sources.
 */
export function deriveObservationTrust(
  sources: readonly ObservationTrust[],
  provenance: readonly string[] = [],
): ObservationTrust {
  if (sources.length === 0) {
    return Object.freeze({
      classification: 'agent-derived',
      instructionAuthority: false,
      provenance: boundedProvenance(provenance),
      containsExternalUntrustedContent: false,
    });
  }

  const containsExternalUntrustedContent = sources.some((source) => source.containsExternalUntrustedContent || source.classification === 'external-untrusted-content');
  const allAuthoritative = sources.every((source) => source.instructionAuthority);
  const inherited = sources.flatMap((source) => source.provenance);

  return Object.freeze({
    classification: 'agent-derived',
    // Agent-derived material is evidence, never a new independent authority source.
    // A caller may separately retain the original user/host authority reference.
    instructionAuthority: false,
    provenance: boundedProvenance([...inherited, ...provenance]),
    containsExternalUntrustedContent,
    ...(allAuthoritative ? {} : {}),
  });
}

export function mayContributeInstructionAuthority(trust: ObservationTrust): boolean {
  return trust.instructionAuthority && !trust.containsExternalUntrustedContent;
}
