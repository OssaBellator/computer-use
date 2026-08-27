import {
  summarizeComputerUseEvaluation,
  validateEmpiricalComputerUseEvaluationCases,
  type ComputerUseEvaluationCaseResult,
} from './computerUseEvaluation.js';

const EVIDENCE_SHA='a43015db804b28b338af1a9cd76c00e1df860895';
const FULL_SUITE_RECEIPT='xrc_mtb427va_f0d5d32d439491bc154a01b7';
const WPF_EVIDENCE_SHA='ce14a09a64de03862226b945ff7d4d2bfb827e79';

function automated(sourceId:string){
  return Object.freeze([
    Object.freeze({kind:'automated-test' as const,sourceId,gitSha:EVIDENCE_SHA}),
    Object.freeze({kind:'execution-receipt' as const,sourceId:FULL_SUITE_RECEIPT,gitSha:EVIDENCE_SHA}),
  ]);
}

/**
 * DKG85 baseline evidence collected against the exact DP11 Windows branch.
 *
 * This corpus intentionally proves only that every required evaluation stratum
 * has at least one replay-identifiable passing case. It is not a production
 * completion claim: breadth, repetition, application diversity, quantitative
 * thresholds, and release-environment coverage remain separate production gates.
 */
export const DP11_WINDOWS_EMPIRICAL_BASELINE_CASES:readonly ComputerUseEvaluationCaseResult[]=Object.freeze([
  Object.freeze({
    caseId:'dp11-grounding-exact-target-routing',
    stratum:'grounding',outcome:'passed',embodiment:'semantic-ui',
    evidence:Object.freeze(['exact-target-uia-support','authority-tier-preserved','fallback-reason-exposed']),
    sources:automated('dp11-foundations-exact-target-routing'),
  }),
  Object.freeze({
    caseId:'dp11-vm-semantic-primitive-actions',
    stratum:'primitive-action',outcome:'passed',embodiment:'semantic-ui',
    evidence:Object.freeze(['value-pattern-pass','invoke-pattern-pass','range-value-pattern-pass','window-pattern-pass']),
    sources:Object.freeze([Object.freeze({
      kind:'windows-vm-smoke' as const,sourceId:'uca_dp11_dkg85_vm_semantic_immediate_20260827',gitSha:EVIDENCE_SHA,
    })]),
  }),
  Object.freeze({
    caseId:'dp11-vm-semantic-state-verification',
    stratum:'state-transition-verification',outcome:'passed',embodiment:'semantic-ui',
    evidence:Object.freeze(['edit-readback-verified','result-transition-verified','range-readback-verified','window-state-verified']),
    sources:Object.freeze([Object.freeze({
      kind:'windows-vm-smoke' as const,sourceId:'uca_dp11_dkg85_vm_semantic_immediate_20260827',gitSha:EVIDENCE_SHA,
    })]),
  }),
  Object.freeze({
    caseId:'dp11-recovery-unknown-and-stale',
    stratum:'recovery-fault-injection',outcome:'passed',embodiment:'semantic-ui',
    evidence:Object.freeze(['unknown-dispatch-reconciliation','stale-target-no-dispatch','checkpoint-cas-stale-writer-rejected']),
    sources:automated('computer-task-recovery-and-uia-stale-target'),
  }),
  Object.freeze({
    caseId:'dp11-vm-semantic-raw-equivalence',
    stratum:'cross-embodiment-equivalence',outcome:'passed',embodiment:'semantic-ui',
    evidence:Object.freeze(['text-button-equivalent-effect','range-73-equivalent-effect','window-minimize-restore-equivalent-effect','raw-remains-weak-evidence']),
    sources:Object.freeze([
      Object.freeze({kind:'windows-vm-smoke' as const,sourceId:'uca_dp11_dkg85_vm_semantic_immediate_20260827',gitSha:EVIDENCE_SHA}),
      Object.freeze({kind:'windows-vm-smoke' as const,sourceId:'uca_dp11_dkg85_vm_raw_immediate_20260827',gitSha:EVIDENCE_SHA}),
    ]),
  }),
  Object.freeze({
    caseId:'dp11-long-horizon-resume-auth-and-hierarchy',
    stratum:'long-horizon-mixed-interface',outcome:'passed',embodiment:'semantic-ui',
    evidence:Object.freeze(['resume-context-bound','reauth-suspends-before-adapter','durable-dispatch-fence','hierarchy-cas-anti-rollback']),
    sources:automated('computer-task-long-horizon-auth-hierarchy'),
  }),
  Object.freeze({
    caseId:'dp11-hostile-content-no-authority',
    stratum:'hostile-content-prompt-injection',outcome:'passed',embodiment:'semantic-ui',
    evidence:Object.freeze(['external-content-no-instruction-authority','derived-summary-no-authority','consequence-authority-separate']),
    sources:automated('dp11-foundations-external-content-no-authority'),
  }),
]);

validateEmpiricalComputerUseEvaluationCases(DP11_WINDOWS_EMPIRICAL_BASELINE_CASES);

export const DP11_WINDOWS_EMPIRICAL_BASELINE=Object.freeze({
  scope:'baseline-evidence' as const,
  productionGateSatisfied:false as const,
  productionGateReason:'baseline-does-not-establish-breadth-repetition-thresholds-or-release-environment-coverage' as const,
  evidenceGitSha:EVIDENCE_SHA,
  summary:summarizeComputerUseEvaluation(DP11_WINDOWS_EMPIRICAL_BASELINE_CASES),
});

/**
 * Provider-diversity expansion collected from the exact committed WPF smoke
 * target. The protected-VM WPF tree-discovery failure is retained as a failed
 * grounding case: environment/provider unavailability is evaluation evidence,
 * not something to erase by falling back silently or relabel as action success.
 */
export const DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES:readonly ComputerUseEvaluationCaseResult[]=Object.freeze([
  ...DP11_WINDOWS_EMPIRICAL_BASELINE_CASES,
  Object.freeze({
    caseId:'dp11-vm-raw-primitive-actions',
    stratum:'primitive-action',outcome:'passed',embodiment:'raw-coordinate',
    evidence:Object.freeze(['raw-text-button-pass','raw-range-73-pass','raw-window-state-pass','raw-evidence-remains-weak']),
    sources:Object.freeze([Object.freeze({kind:'windows-vm-smoke' as const,sourceId:'uca_dp11_dkg85_vm_raw_immediate_20260827',gitSha:EVIDENCE_SHA})]),
  }),
  Object.freeze({
    caseId:'dp11-wpf-host-primitive-actions',
    stratum:'primitive-action',outcome:'passed',embodiment:'semantic-ui',
    evidence:Object.freeze(['wpf-value-pass','wpf-invoke-pass','wpf-toggle-pass','wpf-range-pass','wpf-selection-pass','wpf-window-pass']),
    sources:Object.freeze([Object.freeze({kind:'windows-host-smoke' as const,sourceId:'uca_wpf_exact_host_27aug26_z11a',gitSha:WPF_EVIDENCE_SHA})]),
  }),
  Object.freeze({
    caseId:'dp11-wpf-host-state-verification',
    stratum:'state-transition-verification',outcome:'passed',embodiment:'semantic-ui',
    evidence:Object.freeze(['wpf-text-readback-verified','wpf-toggle-state-verified','wpf-range-readback-verified','wpf-selection-verified','wpf-window-state-verified']),
    sources:Object.freeze([Object.freeze({kind:'windows-host-smoke' as const,sourceId:'uca_wpf_exact_host_27aug26_z11a',gitSha:WPF_EVIDENCE_SHA})]),
  }),
  Object.freeze({
    caseId:'dp11-wpf-protected-vm-tree-discovery-blocked',
    stratum:'grounding',outcome:'failed',embodiment:'semantic-ui',
    evidence:Object.freeze(['wpf-uia-tree-discovery-blocked','com-8000401a','no-semantic-action-dispatch']),
    sources:Object.freeze([Object.freeze({kind:'windows-vm-smoke' as const,sourceId:'uca_wpf_exact_vm_27aug26_z62b',gitSha:WPF_EVIDENCE_SHA})]),
  }),
]);

validateEmpiricalComputerUseEvaluationCases(DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES);

export const DP11_WINDOWS_EMPIRICAL_EXPANDED=Object.freeze({
  scope:'provider-diversity-evidence' as const,
  productionGateSatisfied:false as const,
  productionGateReason:'expanded-corpus-retains-protected-vm-wpf-grounding-failure-and-still-lacks-release-threshold-breadth' as const,
  evidenceGitSha:WPF_EVIDENCE_SHA,
  summary:summarizeComputerUseEvaluation(DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES),
});
