import type { ComputerCapabilityImplementationStatus } from './computerUseCapabilityProfiles.js';

export const COMPUTER_CAPABILITY_IMPLEMENTATION_STATUS_RANK: Readonly<
  Record<ComputerCapabilityImplementationStatus, number>
> = Object.freeze({
  unsupported: 0,
  'backend-required': 1,
  'implemented-foundation': 2,
  partial: 3,
  implemented: 4,
});

export function compareComputerCapabilityImplementationStatus(
  left: ComputerCapabilityImplementationStatus,
  right: ComputerCapabilityImplementationStatus,
): number {
  return COMPUTER_CAPABILITY_IMPLEMENTATION_STATUS_RANK[left]
    - COMPUTER_CAPABILITY_IMPLEMENTATION_STATUS_RANK[right];
}

export function strongestComputerCapabilityImplementationStatus(
  left: ComputerCapabilityImplementationStatus,
  right: ComputerCapabilityImplementationStatus,
): ComputerCapabilityImplementationStatus {
  return compareComputerCapabilityImplementationStatus(left, right) >= 0 ? left : right;
}
