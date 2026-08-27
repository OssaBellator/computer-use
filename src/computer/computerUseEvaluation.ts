export const COMPUTER_USE_EVALUATION_STRATA = [
  'grounding',
  'primitive-action',
  'state-transition-verification',
  'recovery-fault-injection',
  'cross-embodiment-equivalence',
  'long-horizon-mixed-interface',
  'hostile-content-prompt-injection',
] as const;

export type ComputerUseEvaluationStratum = typeof COMPUTER_USE_EVALUATION_STRATA[number];
export type ComputerUseEvaluationOutcome = 'passed'|'failed'|'unknown'|'skipped';

export const COMPUTER_USE_EVALUATION_SOURCE_KINDS = [
  'automated-test',
  'execution-receipt',
  'windows-host-smoke',
  'windows-vm-smoke',
] as const;

export type ComputerUseEvaluationSourceKind = typeof COMPUTER_USE_EVALUATION_SOURCE_KINDS[number];

export interface ComputerUseEvaluationEvidenceSource {
  readonly kind:ComputerUseEvaluationSourceKind;
  readonly sourceId:string;
  readonly gitSha?:string;
  /** Records from the same empirical execution share this identity for breadth accounting. */
  readonly independenceId?:string;
}

export interface ComputerUseEvaluationCaseResult {
  readonly caseId:string;
  readonly stratum:ComputerUseEvaluationStratum;
  readonly outcome:ComputerUseEvaluationOutcome;
  /** Repeated executions represented by this source result. Defaults to 1. */
  readonly trials?:number;
  readonly embodiment?:string;
  /** Application/harness family exercised by this empirical case; omitted when not application-bound. */
  readonly applicationId?:string;
  /** Semantic/native provider family exercised by this case; omitted when provider-neutral. */
  readonly providerFamily?:string;
  readonly evidence?:readonly string[];
  readonly sources?:readonly ComputerUseEvaluationEvidenceSource[];
}

export interface ComputerUseEvaluationStratumSummary {
  readonly stratum:ComputerUseEvaluationStratum;
  readonly total:number;
  readonly attempted:number;
  readonly passed:number;
  readonly failed:number;
  readonly unknown:number;
  readonly skipped:number;
  readonly attemptedTrials:number;
  readonly passedTrials:number;
  readonly failedTrials:number;
  readonly unknownTrials:number;
  readonly successRate:number;
  readonly complete:boolean;
  readonly passing:boolean;
}

export interface ComputerUseEvaluationSummary {
  readonly totalCases:number;
  readonly attemptedCases:number;
  readonly passedCases:number;
  readonly failedCases:number;
  readonly unknownCases:number;
  readonly skippedCases:number;
  readonly successRate:number;
  readonly strata:readonly ComputerUseEvaluationStratumSummary[];
  readonly missingStrata:readonly ComputerUseEvaluationStratum[];
  readonly complete:boolean;
  readonly passing:boolean;
}

const CASE_ID=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
const EMBODIMENT=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
const EVIDENCE=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
const MAX_CASES=10_000;
const MAX_EVIDENCE_PER_CASE=32;
const MAX_SOURCES_PER_CASE=8;
const GIT_SHA=/^[0-9a-f]{40}$/;
const MAX_TRIALS_PER_CASE=10_000;

function validateCase(entry:ComputerUseEvaluationCaseResult):void{
  if(!entry||typeof entry!=='object'||!CASE_ID.test(entry.caseId))throw new Error('computer-use-evaluation-case-id-invalid');
  if(!COMPUTER_USE_EVALUATION_STRATA.includes(entry.stratum))throw new Error('computer-use-evaluation-stratum-invalid');
  if(!['passed','failed','unknown','skipped'].includes(entry.outcome))throw new Error('computer-use-evaluation-outcome-invalid');
  if(entry.trials!==undefined&&(!Number.isSafeInteger(entry.trials)||entry.trials<1||entry.trials>MAX_TRIALS_PER_CASE))throw new Error('computer-use-evaluation-trials-invalid');
  if(entry.embodiment!==undefined&&!EMBODIMENT.test(entry.embodiment))throw new Error('computer-use-evaluation-embodiment-invalid');
  if(entry.applicationId!==undefined&&!EVIDENCE.test(entry.applicationId))throw new Error('computer-use-evaluation-application-id-invalid');
  if(entry.providerFamily!==undefined&&!EVIDENCE.test(entry.providerFamily))throw new Error('computer-use-evaluation-provider-family-invalid');
  if(entry.evidence!==undefined){
    if(!Array.isArray(entry.evidence)||entry.evidence.length>MAX_EVIDENCE_PER_CASE||entry.evidence.some((value)=>typeof value!=='string'||!EVIDENCE.test(value)))
      throw new Error('computer-use-evaluation-evidence-invalid');
  }
  if(entry.sources!==undefined){
    if(!Array.isArray(entry.sources)||entry.sources.length>MAX_SOURCES_PER_CASE)throw new Error('computer-use-evaluation-source-count-invalid');
    const sourceIds=new Set<string>();
    for(const source of entry.sources){
      if(!source||typeof source!=='object'||!COMPUTER_USE_EVALUATION_SOURCE_KINDS.includes(source.kind)||!EVIDENCE.test(source.sourceId))
        throw new Error('computer-use-evaluation-source-invalid');
      if(source.gitSha!==undefined&&!GIT_SHA.test(source.gitSha))throw new Error('computer-use-evaluation-source-git-sha-invalid');
      if(source.independenceId!==undefined&&!EVIDENCE.test(source.independenceId))throw new Error('computer-use-evaluation-source-independence-id-invalid');
      const identity=`${source.kind}:${source.sourceId}:${source.gitSha??''}`;
      if(sourceIds.has(identity))throw new Error('computer-use-evaluation-source-duplicate');
      sourceIds.add(identity);
    }
  }
}

/**
 * Stronger validation for a production-facing empirical corpus. Any attempted
 * case must point at at least one immutable or replay-identifiable source.
 */
export function validateEmpiricalComputerUseEvaluationCases(cases:readonly ComputerUseEvaluationCaseResult[]):void{
  if(!Array.isArray(cases)||cases.length>MAX_CASES)throw new Error('computer-use-evaluation-case-count-invalid');
  for(const entry of cases){
    validateCase(entry);
    if(entry.outcome!=='skipped'&&(!entry.sources||entry.sources.length===0))
      throw new Error('computer-use-evaluation-empirical-source-required');
  }
}

/**
 * Summarize empirical computer-use evaluation without turning missing, skipped,
 * failed, or UNKNOWN cases into success. Every DKG85 stratum must have at least
 * one attempted case before the evaluation is complete.
 */
export function summarizeComputerUseEvaluation(cases:readonly ComputerUseEvaluationCaseResult[]):ComputerUseEvaluationSummary{
  if(!Array.isArray(cases)||cases.length>MAX_CASES)throw new Error('computer-use-evaluation-case-count-invalid');
  const ids=new Set<string>();
  for(const entry of cases){
    validateCase(entry);
    if(ids.has(entry.caseId))throw new Error('computer-use-evaluation-case-duplicate');
    ids.add(entry.caseId);
  }

  const strata=Object.freeze(COMPUTER_USE_EVALUATION_STRATA.map((stratum)=>{
    const entries=cases.filter((entry)=>entry.stratum===stratum);
    const passed=entries.filter((entry)=>entry.outcome==='passed').length;
    const failed=entries.filter((entry)=>entry.outcome==='failed').length;
    const unknown=entries.filter((entry)=>entry.outcome==='unknown').length;
    const skipped=entries.filter((entry)=>entry.outcome==='skipped').length;
    const attempted=passed+failed+unknown;
    const trialCount=(entry:ComputerUseEvaluationCaseResult)=>entry.trials??1;
    const attemptedTrials=entries.filter((entry)=>entry.outcome!=='skipped').reduce((sum,entry)=>sum+trialCount(entry),0);
    const passedTrials=entries.filter((entry)=>entry.outcome==='passed').reduce((sum,entry)=>sum+trialCount(entry),0);
    const failedTrials=entries.filter((entry)=>entry.outcome==='failed').reduce((sum,entry)=>sum+trialCount(entry),0);
    const unknownTrials=entries.filter((entry)=>entry.outcome==='unknown').reduce((sum,entry)=>sum+trialCount(entry),0);
    const complete=attempted>0;
    return Object.freeze({
      stratum,total:entries.length,attempted,passed,failed,unknown,skipped,
      attemptedTrials,passedTrials,failedTrials,unknownTrials,
      successRate:attemptedTrials===0?0:passedTrials/attemptedTrials,
      complete,
      passing:complete&&failed===0&&unknown===0&&passed===attempted,
    });
  }));
  const missingStrata=Object.freeze(strata.filter((entry)=>!entry.complete).map((entry)=>entry.stratum));
  const passedCases=cases.filter((entry)=>entry.outcome==='passed').length;
  const failedCases=cases.filter((entry)=>entry.outcome==='failed').length;
  const unknownCases=cases.filter((entry)=>entry.outcome==='unknown').length;
  const skippedCases=cases.filter((entry)=>entry.outcome==='skipped').length;
  const attemptedCases=passedCases+failedCases+unknownCases;
  const complete=missingStrata.length===0;
  return Object.freeze({
    totalCases:cases.length,attemptedCases,passedCases,failedCases,unknownCases,skippedCases,
    successRate:attemptedCases===0?0:passedCases/attemptedCases,
    strata,missingStrata,complete,
    passing:complete&&strata.every((entry)=>entry.passing),
  });
}
