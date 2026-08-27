import { validateEmpiricalComputerUseEvaluationCases, type ComputerUseEvaluationCaseResult, type ComputerUseEvaluationSourceKind } from './computerUseEvaluation.js';

const TOKEN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MAX_EVIDENCE=128;

export type WindowsUiaSemanticCorrectionEvidenceBinding=Readonly<{
  evidenceId:string;
  caseId:string;
  outcome:ComputerUseEvaluationCaseResult['outcome'];
  sourceKind:ComputerUseEvaluationSourceKind;
  gitSha:string;
  applicationId?:string;
  providerFamily?:string;
}>;

export type WindowsUiaSemanticCorrectionEvidenceAssessment=
  | Readonly<{
      status:'bound';
      evidenceIds:readonly string[];
      bindings:readonly WindowsUiaSemanticCorrectionEvidenceBinding[];
      promotionApproved:false;
      authorityGranted:false;
    }>
  | Readonly<{
      status:'rejected';
      reason:string;
      evidenceIds:readonly string[];
      bindings:readonly WindowsUiaSemanticCorrectionEvidenceBinding[];
      promotionApproved:false;
      authorityGranted:false;
    }>;

function validEvidenceIds(values:unknown):values is readonly string[]{
  if(!Array.isArray(values)||values.length===0||values.length>MAX_EVIDENCE)return false;
  const seen=new Set<string>();
  for(const value of values){
    if(typeof value!=='string'||!TOKEN.test(value)||seen.has(value))return false;
    seen.add(value);
  }
  return true;
}

function rejectEvidence(
  evidenceIds:readonly string[],
  bindings:readonly WindowsUiaSemanticCorrectionEvidenceBinding[],
  reason:string,
):WindowsUiaSemanticCorrectionEvidenceAssessment {
  return Object.freeze({
    status:'rejected' as const,reason,evidenceIds,bindings:Object.freeze([...bindings]),
    promotionApproved:false as const,authorityGranted:false as const,
  });
}

type IndexedEvidenceSource=WindowsUiaSemanticCorrectionEvidenceBinding|null;

function indexEvidenceBindings(
  cases:readonly ComputerUseEvaluationCaseResult[],
  requestedEvidenceIds:ReadonlySet<string>,
):ReadonlyMap<string,readonly IndexedEvidenceSource[]>{
  const byEvidenceId=new Map<string,IndexedEvidenceSource[]>();
  for(const entry of cases){
    for(const source of entry.sources??[]){
      if(!requestedEvidenceIds.has(source.sourceId))continue;
      const indexed:IndexedEvidenceSource=typeof source.gitSha==='string'
        ?Object.freeze({
            evidenceId:source.sourceId,caseId:entry.caseId,outcome:entry.outcome,sourceKind:source.kind,gitSha:source.gitSha,
            ...(entry.applicationId!==undefined?{applicationId:entry.applicationId}:{}),
            ...(entry.providerFamily!==undefined?{providerFamily:entry.providerFamily}:{}),
          })
        :null;
      const existing=byEvidenceId.get(source.sourceId);
      if(existing)existing.push(indexed);
      else byEvidenceId.set(source.sourceId,[indexed]);
    }
  }
  return byEvidenceId;
}

/**
 * Bind correction/review evidence tokens to exact empirical source records.
 * This is provenance validation only: failed cases may legitimately motivate a
 * correction, and a successful binding never approves, activates or authorizes it.
 */
export function assessWindowsUiaSemanticCorrectionEvidence(
  cases:readonly ComputerUseEvaluationCaseResult[],
  evidenceIds:readonly string[],
):WindowsUiaSemanticCorrectionEvidenceAssessment {
  if(!validEvidenceIds(evidenceIds))throw new Error('windows-uia-semantic-correction-evidence-ids-invalid');
  validateEmpiricalComputerUseEvaluationCases(cases);

  const frozenEvidenceIds=Object.freeze([...evidenceIds]);
  const indexed=indexEvidenceBindings(cases,new Set(frozenEvidenceIds));
  const bindings:WindowsUiaSemanticCorrectionEvidenceBinding[]=[];
  for(const evidenceId of frozenEvidenceIds){
    const matches=indexed.get(evidenceId);
    if(matches===undefined)return rejectEvidence(frozenEvidenceIds,bindings,`evidence-source-missing:${evidenceId}`);
    for(const match of matches){
      if(match===null)return rejectEvidence(frozenEvidenceIds,bindings,`evidence-source-git-sha-missing:${evidenceId}`);
      bindings.push(match);
    }
  }
  bindings.sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId)||a.caseId.localeCompare(b.caseId)||a.sourceKind.localeCompare(b.sourceKind));
  return Object.freeze({
    status:'bound' as const,evidenceIds:frozenEvidenceIds,bindings:Object.freeze(bindings),
    promotionApproved:false as const,authorityGranted:false as const,
  });
}
