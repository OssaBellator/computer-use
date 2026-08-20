import {
  COMPUTER_CAPABILITIES,
  type ComputerCapability,
} from './computerCapabilities.js';
import {
  compareComputerCapabilityImplementationStatus,
} from './computerCapabilityImplementationStatusOrdering.js';
import {
  HIGH_RISK_COMPUTER_CAPABILITIES,
  computerCapabilityImplementationState,
  type ComputerCapabilityImplementationStatus,
  type ComputerCapabilityScope,
  type ComputerUseCapabilityProfile,
} from './computerUseCapabilityProfiles.js';

export type ComputerCapabilityStatusChange = 'promoted' | 'demoted' | 'unchanged';

export interface ComputerCapabilityProfileDelta {
  capability: ComputerCapability;
  highRisk: boolean;
  beforeStatus: ComputerCapabilityImplementationStatus;
  afterStatus: ComputerCapabilityImplementationStatus;
  statusChange: ComputerCapabilityStatusChange;
  addedScopes: readonly ComputerCapabilityScope[];
  removedScopes: readonly ComputerCapabilityScope[];
  noteChanged: boolean;
}

function codeUnitCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function statusChange(
  before: ComputerCapabilityImplementationStatus,
  after: ComputerCapabilityImplementationStatus,
): ComputerCapabilityStatusChange {
  const comparison = compareComputerCapabilityImplementationStatus(after, before);
  if (comparison > 0) return 'promoted';
  if (comparison < 0) return 'demoted';
  return 'unchanged';
}

function scopeDifference(
  left: readonly ComputerCapabilityScope[],
  right: readonly ComputerCapabilityScope[],
): readonly ComputerCapabilityScope[] {
  const rightSet = new Set(right);
  return Object.freeze(left.filter((scope) => !rightSet.has(scope)).sort(codeUnitCompare));
}

/**
 * Compare two computer-use capability profiles in taxonomy order. By default,
 * unchanged capabilities are omitted so review tooling can focus on meaningful
 * support/provenance changes without relying on notes or prose inspection.
 */
export function diffComputerUseCapabilityProfiles(
  before: ComputerUseCapabilityProfile,
  after: ComputerUseCapabilityProfile,
  options: { includeUnchanged?: boolean } = {},
): readonly ComputerCapabilityProfileDelta[] {
  const deltas: ComputerCapabilityProfileDelta[] = [];
  const highRisk = new Set<ComputerCapability>(HIGH_RISK_COMPUTER_CAPABILITIES);

  for (const capability of COMPUTER_CAPABILITIES) {
    const beforeState = computerCapabilityImplementationState(before, capability);
    const afterState = computerCapabilityImplementationState(after, capability);
    const change = statusChange(beforeState.status, afterState.status);
    const addedScopes = scopeDifference(afterState.scopes, beforeState.scopes);
    const removedScopes = scopeDifference(beforeState.scopes, afterState.scopes);
    const noteChanged = beforeState.note !== afterState.note;

    if (
      !options.includeUnchanged
      && change === 'unchanged'
      && addedScopes.length === 0
      && removedScopes.length === 0
      && !noteChanged
    ) {
      continue;
    }

    deltas.push(Object.freeze({
      capability,
      highRisk: highRisk.has(capability),
      beforeStatus: beforeState.status,
      afterStatus: afterState.status,
      statusChange: change,
      addedScopes,
      removedScopes,
      noteChanged,
    }));
  }

  return Object.freeze(deltas);
}

export function findHighRiskComputerCapabilityPromotions(
  before: ComputerUseCapabilityProfile,
  after: ComputerUseCapabilityProfile,
): readonly ComputerCapabilityProfileDelta[] {
  return Object.freeze(
    diffComputerUseCapabilityProfiles(before, after)
      .filter((delta) => delta.highRisk && delta.statusChange === 'promoted'),
  );
}
