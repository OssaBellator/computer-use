/**
 * Stable, authority-free local-compute descriptors.
 *
 * Concrete adapters, operation registries, backend/fault-injection options, and
 * host-authority construction remain source-internal until intentionally promoted.
 */
export { LOCAL_COMPUTE_EXECUTION_MODEL } from './localComputeAdapter.js';
export { ISOLATED_LOCAL_COMPUTE_EXECUTION_MODEL } from './isolatedLocalComputeAdapter.js';
export {
  LOCAL_COMPUTE_GUARANTEES,
  ISOLATED_LOCAL_COMPUTE_GUARANTEES,
  type LocalComputeGuaranteeProfile,
} from './localComputeGuarantees.js';
