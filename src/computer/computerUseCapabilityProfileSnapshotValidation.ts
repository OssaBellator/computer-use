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

interface OwnDataProperty {
  present: boolean;
  data: boolean;
  value?: unknown;
}

function ownDataProperty(record: object, key: PropertyKey): OwnDataProperty {
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor) return { present: false, data: false };
  if (!Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
    return { present: true, data: false };
  }
  return { present: true, data: true, value: descriptor.value };
}

function dataValue(record: object, key: PropertyKey): unknown {
  const property = ownDataProperty(record, key);
  return property.present && property.data ? property.value : undefined;
}

/**
 * Validate an untrusted/serialized capability-profile snapshot without assuming
 * it already satisfies the TypeScript profile shape. Snapshot fields must be
 * own data properties, matching parsed-JSON semantics; accessors are rejected
 * without invocation. The validator is fail-closed and returns deterministic
 * error codes rather than throwing on malformed JSON-shaped input.
 */
export function validateComputerUseCapabilityProfileSnapshot(
  value: unknown,
  options: ComputerUseCapabilityProfileSnapshotValidationOptions = {},
): readonly string[] {
  const errors: string[] = [];
  if (!isRecord(value)) return Object.freeze(['profile.invalid']);

  const id = dataValue(value, 'id');
  if (typeof id !== 'string' || !id.trim()) errors.push('profile.id.invalid');

  const version = dataValue(value, 'version');
  if (typeof version !== 'string' || !/^\d+\.\d+(?:\.\d+)?$/u.test(version)) {
    errors.push('profile.version.invalid');
  }

  const kind = dataValue(value, 'kind');
  if (kind !== 'component' && kind !== 'composition') errors.push('profile.kind.invalid');

  const capabilities = dataValue(value, 'capabilities');
  if (!isRecord(capabilities)) {
    errors.push('profile.capabilities.invalid');
    return Object.freeze(errors);
  }

  for (const capability of Object.keys(capabilities)) {
    if (!COMPUTER_CAPABILITIES.includes(capability as ComputerCapability)) {
      errors.push(`capability.unknown:${capability}`);
      continue;
    }

    const rawProperty = ownDataProperty(capabilities, capability);
    const raw = rawProperty.present && rawProperty.data ? rawProperty.value : undefined;
    if (!isRecord(raw)) {
      errors.push(`capability.state.invalid:${capability}`);
      continue;
    }

    const status = dataValue(raw, 'status');
    if (
      typeof status !== 'string'
      || !COMPUTER_CAPABILITY_IMPLEMENTATION_STATUSES.includes(status as ComputerCapabilityImplementationStatus)
    ) {
      errors.push(`capability.status.invalid:${capability}`);
    }

    const scopes = dataValue(raw, 'scopes');
    if (!Array.isArray(scopes) || scopes.length < 1) {
      errors.push(`capability.scope.invalid:${capability}`);
    } else {
      const seen = new Set<string>();
      let invalidScope = false;
      for (let index = 0; index < scopes.length; index += 1) {
        const scopeProperty = ownDataProperty(scopes, String(index));
        const scope = scopeProperty.present && scopeProperty.data ? scopeProperty.value : undefined;
        if (
          typeof scope !== 'string'
          || !COMPUTER_CAPABILITY_SCOPES.includes(scope as ComputerCapabilityScope)
        ) {
          invalidScope = true;
          continue;
        }
        if (seen.has(scope)) errors.push(`capability.scope.duplicate:${capability}:${scope}`);
        seen.add(scope);
      }
      if (invalidScope) errors.push(`capability.scope.invalid:${capability}`);
    }

    const note = ownDataProperty(raw, 'note');
    if (note.present && (!note.data || typeof note.value !== 'string')) {
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
