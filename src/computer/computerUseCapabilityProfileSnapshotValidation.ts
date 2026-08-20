import {
  COMPUTER_CAPABILITIES,
  type ComputerCapability,
} from './computerCapabilities.js';
import {
  COMPUTER_CAPABILITY_IMPLEMENTATION_STATUSES,
  COMPUTER_CAPABILITY_SCOPES,
  HIGH_RISK_COMPUTER_CAPABILITIES,
  type ComputerCapabilityImplementationStatus,
  type ComputerCapabilityScope,
  type ComputerUseCapabilityProfile,
} from './computerUseCapabilityProfiles.js';

export interface ComputerUseCapabilityProfileSnapshotValidationOptions {
  requireComplete?: boolean;
  requireExplicitHighRisk?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Validate an untrusted/serialized capability-profile snapshot without assuming
 * it already satisfies the TypeScript profile shape. This is intentionally
 * fail-closed and returns deterministic error codes rather than throwing on
 * malformed JSON-shaped input.
 */
export function validateComputerUseCapabilityProfileSnapshot(
  value: unknown,
  options: ComputerUseCapabilityProfileSnapshotValidationOptions = {},
): readonly string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return Object.freeze(['profile.invalid']);

  const id = value.id;
  if (typeof id !== 'string' || !id.trim()) errors.push('profile.id.invalid');

  const version = value.version;
  if (typeof version !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/u.test(version)) {
    errors.push('profile.version.invalid');
  }

  const kind = value.kind;
  if (kind !== 'component' && kind !== 'composition') errors.push('profile.kind.invalid');

  const capabilities = value.capabilities;
  if (!isRecord(capabilities)) {
    errors.push('profile.capabilities.invalid');
    return Object.freeze(errors);
  }

  for (const [capability, raw] of Object.entries(capabilities)) {
    if (!COMPUTER_CAPABILITIES.includes(capability as ComputerCapability)) {
      errors.push(`capability.unknown:${capability}`);
      continue;
    }
    if (!isRecord(raw)) {
      errors.push(`capability.state.invalid:${capability}`);
      continue;
    }

    const status = raw.status;
    if (
      typeof status !== 'string'
      || !COMPUTER_CAPABILITY_IMPLEMENTATION_STATUSES.includes(status as ComputerCapabilityImplementationStatus)
    ) {
      errors.push(`capability.status.invalid:${capability}`);
    }

    const scopes = raw.scopes;
    if (!Array.isArray(scopes) || scopes.length < 1) {
      errors.push(`capability.scope.invalid:${capability}`);
    } else {
      const seen = new Set<string>();
      for (const scope of scopes) {
        if (
          typeof scope !== 'string'
          || !COMPUTER_CAPABILITY_SCOPES.includes(scope as ComputerCapabilityScope)
        ) {
          errors.push(`capability.scope.invalid:${capability}`);
          continue;
        }
        if (seen.has(scope)) errors.push(`capability.scope.duplicate:${capability}:${scope}`);
        seen.add(scope);
      }
    }

    if (Object.prototype.hasOwnProperty.call(raw, 'note') && typeof raw.note !== 'string') {
      errors.push(`capability.note.invalid:${capability}`);
    }
  }

  if (options.requireComplete) {
    for (const capability of COMPUTER_CAPABILITIES) {
      if (!Object.prototype.hasOwnProperty.call(capabilities, capability)) {
        errors.push(`capability.missing:${capability}`);
      }
    }
  }

  if (options.requireExplicitHighRisk) {
    for (const capability of HIGH_RISK_COMPUTER_CAPABILITIES) {
      if (!Object.prototype.hasOwnProperty.call(capabilities, capability)) {
        errors.push(`high-risk-capability.not-explicit:${capability}`);
      }
    }
  }

  return Object.freeze(errors);
}

export function isComputerUseCapabilityProfileSnapshot(
  value: unknown,
  options: ComputerUseCapabilityProfileSnapshotValidationOptions = {},
): value is ComputerUseCapabilityProfile {
  return validateComputerUseCapabilityProfileSnapshot(value, options).length === 0;
}
