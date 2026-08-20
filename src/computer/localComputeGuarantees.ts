import { LOCAL_COMPUTE_EXECUTION_MODEL } from './localComputeAdapter.js';
import { ISOLATED_LOCAL_COMPUTE_EXECUTION_MODEL } from './isolatedLocalComputeAdapter.js';

export interface LocalComputeGuaranteeProfile {
  readonly executionModel: typeof LOCAL_COMPUTE_EXECUTION_MODEL | typeof ISOLATED_LOCAL_COMPUTE_EXECUTION_MODEL;
  readonly isolationBoundary: 'trusted-same-process' | 'separate-child-process';
  readonly deadline: 'cooperative-abort-with-post-return-check' | 'parent-wall-clock-enforced';
  readonly timeoutTermination: 'not-enforceable' | 'forced-child-termination-with-confirmation';
  readonly serializedInputOutput: 'canonical-json-bounded';
  readonly dispatchLedger: 'non-evicted-adapter-lifetime-capacity-fails-closed';
  readonly memory: 'hint-only-not-enforced';
  readonly filesystem: 'trusted-operation-authority-not-sandboxed';
  readonly network: 'trusted-operation-authority-not-sandboxed';
}

/** Machine-readable guarantee boundary for trusted cooperative in-process compute. */
export const LOCAL_COMPUTE_GUARANTEES: Readonly<LocalComputeGuaranteeProfile> = Object.freeze({
  executionModel: LOCAL_COMPUTE_EXECUTION_MODEL,
  isolationBoundary: 'trusted-same-process',
  deadline: 'cooperative-abort-with-post-return-check',
  timeoutTermination: 'not-enforceable',
  serializedInputOutput: 'canonical-json-bounded',
  dispatchLedger: 'non-evicted-adapter-lifetime-capacity-fails-closed',
  memory: 'hint-only-not-enforced',
  filesystem: 'trusted-operation-authority-not-sandboxed',
  network: 'trusted-operation-authority-not-sandboxed',
});

/** Machine-readable guarantee boundary for child-process isolated compute. */
export const ISOLATED_LOCAL_COMPUTE_GUARANTEES: Readonly<LocalComputeGuaranteeProfile> = Object.freeze({
  executionModel: ISOLATED_LOCAL_COMPUTE_EXECUTION_MODEL,
  isolationBoundary: 'separate-child-process',
  deadline: 'parent-wall-clock-enforced',
  timeoutTermination: 'forced-child-termination-with-confirmation',
  serializedInputOutput: 'canonical-json-bounded',
  dispatchLedger: 'non-evicted-adapter-lifetime-capacity-fails-closed',
  memory: 'hint-only-not-enforced',
  filesystem: 'trusted-operation-authority-not-sandboxed',
  network: 'trusted-operation-authority-not-sandboxed',
});
