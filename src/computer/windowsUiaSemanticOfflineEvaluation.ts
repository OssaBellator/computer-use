import type { WindowsUiaCachedObservation } from './windowsUiaContract.js';
import { instantiateWindowsUiaSemanticRecipe, type WindowsUiaSemanticRecipeInputs } from './windowsUiaSemanticRecipe.js';
import { validateWindowsUiaSemanticRecipeRevision, type WindowsUiaSemanticRecipeManifest } from './windowsUiaSemanticRecipeManifest.js';

const TOKEN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MAX_CASES=256;

export interface WindowsUiaSemanticOfflineReplayCase {
  readonly caseId:string;
  readonly observation:WindowsUiaCachedObservation;
  readonly inputs?:WindowsUiaSemanticRecipeInputs;
}

export interface WindowsUiaSemanticOfflineEvaluation {
  readonly status:'improved'|'non-regressing'|'regressed';
  readonly cases:number;
  readonly recoveries:number;
  readonly regressions:number;
  readonly stableReady:number;
  readonly proposedUnresolved:number;
  readonly caseResults:readonly Readonly<{
    caseId:string;
    baseStatus:string;
    proposedStatus:string;
  }>[];
  /** Offline replay never constitutes promotion or execution authority. */
  readonly promotionEligible:false;
  readonly authorityGranted:false;
}

/**
 * Compare one exact recipe revision against its exact child revision on the same
 * bounded semantic observations. This performs grounding/action materialization
 * only; neither recipe is dispatched. A no-regression replay is evidence for
 * review, not an activation or authority decision.
 */
export function evaluateWindowsUiaSemanticRecipeOffline(
  base:WindowsUiaSemanticRecipeManifest,
  proposed:WindowsUiaSemanticRecipeManifest,
  cases:readonly WindowsUiaSemanticOfflineReplayCase[],
):WindowsUiaSemanticOfflineEvaluation {
  validateWindowsUiaSemanticRecipeRevision(base,proposed);
  if(!Array.isArray(cases)||cases.length===0||cases.length>MAX_CASES)throw new Error('windows-uia-semantic-offline-evaluation-cases-invalid');
  const seen=new Set<string>();
  let recoveries=0,regressions=0,stableReady=0,proposedUnresolved=0;
  const caseResults:Array<{caseId:string;baseStatus:string;proposedStatus:string}>=[];
  for(const entry of cases){
    if(!entry||typeof entry!=='object'||typeof entry.caseId!=='string'||!TOKEN.test(entry.caseId)||seen.has(entry.caseId))
      throw new Error('windows-uia-semantic-offline-evaluation-case-id-invalid');
    seen.add(entry.caseId);
    const inputs=entry.inputs??Object.freeze({});
    const before=instantiateWindowsUiaSemanticRecipe(entry.observation,base.recipe,inputs);
    const after=instantiateWindowsUiaSemanticRecipe(entry.observation,proposed.recipe,inputs);
    const beforeReady=before.status==='ready';
    const afterReady=after.status==='ready';
    if(!beforeReady&&afterReady)recoveries+=1;
    else if(beforeReady&&!afterReady)regressions+=1;
    else if(beforeReady&&afterReady)stableReady+=1;
    if(!afterReady)proposedUnresolved+=1;
    caseResults.push(Object.freeze({caseId:entry.caseId,baseStatus:before.status,proposedStatus:after.status}));
  }
  const status=regressions>0?'regressed':recoveries>0?'improved':'non-regressing';
  return Object.freeze({
    status,cases:cases.length,recoveries,regressions,stableReady,proposedUnresolved,
    caseResults:Object.freeze(caseResults),promotionEligible:false as const,authorityGranted:false as const,
  });
}
