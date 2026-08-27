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
  return Array.isArray(values)&&values.length>0&&values.length<=MAX_EVIDENCE&&
    values.every((value)=>typeof value==='string'&&TOKEN.test(value))&&new Set(values).size===values.length;
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

  const bindings:WindowsUiaSemanticCorrectionEvidenceBinding[]=[];
  for(const evidenceId of evidenceIds){
    let found=false;
    for(const entry of cases){
      for(const source of entry.sources??[]){
        if(source.sourceId!==evidenceId)continue;
        found=true;
        if(typeof source.gitSha!=='string'){
          return Object.freeze({
            status:'rejected' as const,reason:`evidence-source-git-sha-missing:${evidenceId}`,
            evidenceIds:Object.freeze([...evidenceIds]),bindings:Object.freeze([...bindings]),
            promotionApproved:false as const,authorityGranted:false as const,
          });
        }
        bindings.push(Object.freeze({
          evidenceId,caseId:entry.caseId,outcome:entry.outcome,sourceKind:source.kind,gitSha:source.gitSha,
          ...(entry.applicationId!==undefined?{applicationId:entry.applicationId}:{}),
          ...(entry.providerFamily!==undefined?{providerFamily:entry.providerFamily}:{}),
        }));
      }
    }
    if(!found){
      return Object.freeze({
        status:'rejected' as const,reason:`evidence-source-missing:${evidenceId}`,
        evidenceIds:Object.freeze([...evidenceIds]),bindings:Object.freeze([...bindings]),
        promotionApproved:false as const,authorityGranted:false as const,
      });
    }
  }
  bindings.sort((a,b)=>a.evidenceId.localeCompare(b.evidenceId)||a.caseId.localeCompare(b.caseId)||a.sourceKind.localeCompare(b.sourceKind));
  return Object.freeze({
    status:'bound' as const,evidenceIds:Object.freeze([...evidenceIds]),bindings:Object.freeze(bindings),
    promotionApproved:false as const,authorityGranted:false as const,
  });
}
