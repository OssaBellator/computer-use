import type { WindowsUiaCachedObservation } from './windowsUiaContract.js';
import { instantiateWindowsUiaSemanticRecipe, type WindowsUiaSemanticRecipeInputs } from './windowsUiaSemanticRecipe.js';
import { validateWindowsUiaSemanticRecipeRevision, type WindowsUiaSemanticRecipeManifest } from './windowsUiaSemanticRecipeManifest.js';

const TOKEN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MAX_CASES=256;

export interface WindowsUiaSemanticOfflineReplayCase {
  readonly caseId:string;
  /** Measurement labels only; they carry no execution or promotion authority. */
  readonly applicationId?:string;
  readonly providerFamily?:string;
  /** Explicit replay split; defaults to development when omitted. */
  readonly partition?:'development'|'holdout';
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
  readonly generalization:Readonly<{
    distinctApplications:number;
    distinctProviderFamilies:number;
    domains:readonly Readonly<{
      domainId:string;
      cases:number;
      recoveries:number;
      regressions:number;
      stableReady:number;
      proposedUnresolved:number;
    }>[];
    partitions:readonly Readonly<{
      partition:'development'|'holdout';
      cases:number;
      recoveries:number;
      regressions:number;
      stableReady:number;
      proposedUnresolved:number;
      distinctApplications:number;
      distinctProviderFamilies:number;
    }>[];
  }>;
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
  const applications=new Set<string>();
  const providers=new Set<string>();
  const domains=new Map<string,{cases:number;recoveries:number;regressions:number;stableReady:number;proposedUnresolved:number}>();
  const partitions=new Map<'development'|'holdout',{cases:number;recoveries:number;regressions:number;stableReady:number;proposedUnresolved:number;applications:Set<string>;providers:Set<string>}>();
  let recoveries=0,regressions=0,stableReady=0,proposedUnresolved=0;
  const caseResults:Array<{caseId:string;baseStatus:string;proposedStatus:string}>=[];
  for(const entry of cases){
    if(!entry||typeof entry!=='object'||typeof entry.caseId!=='string'||!TOKEN.test(entry.caseId)||seen.has(entry.caseId))
      throw new Error('windows-uia-semantic-offline-evaluation-case-id-invalid');
    seen.add(entry.caseId);
    if(entry.applicationId!==undefined&&(!TOKEN.test(entry.applicationId)))throw new Error('windows-uia-semantic-offline-evaluation-application-id-invalid');
    if(entry.providerFamily!==undefined&&(!TOKEN.test(entry.providerFamily)))throw new Error('windows-uia-semantic-offline-evaluation-provider-family-invalid');
    if(entry.partition!==undefined&&entry.partition!=='development'&&entry.partition!=='holdout')throw new Error('windows-uia-semantic-offline-evaluation-partition-invalid');
    if(entry.applicationId!==undefined)applications.add(entry.applicationId);
    if(entry.providerFamily!==undefined)providers.add(entry.providerFamily);
    const partition=entry.partition??'development';
    const partitionStats=partitions.get(partition)??{cases:0,recoveries:0,regressions:0,stableReady:0,proposedUnresolved:0,applications:new Set<string>(),providers:new Set<string>()};
    partitionStats.cases+=1;
    if(entry.applicationId!==undefined)partitionStats.applications.add(entry.applicationId);
    if(entry.providerFamily!==undefined)partitionStats.providers.add(entry.providerFamily);
    const domainId=`${entry.applicationId??'unknown-app'}:${entry.providerFamily??'unknown-provider'}`;
    const domain=domains.get(domainId)??{cases:0,recoveries:0,regressions:0,stableReady:0,proposedUnresolved:0};
    domain.cases+=1;
    const inputs=entry.inputs??Object.freeze({});
    const before=instantiateWindowsUiaSemanticRecipe(entry.observation,base.recipe,inputs);
    const after=instantiateWindowsUiaSemanticRecipe(entry.observation,proposed.recipe,inputs);
    const beforeReady=before.status==='ready';
    const afterReady=after.status==='ready';
    if(!beforeReady&&afterReady){recoveries+=1;domain.recoveries+=1;partitionStats.recoveries+=1;}
    else if(beforeReady&&!afterReady){regressions+=1;domain.regressions+=1;partitionStats.regressions+=1;}
    else if(beforeReady&&afterReady){stableReady+=1;domain.stableReady+=1;partitionStats.stableReady+=1;}
    if(!afterReady){proposedUnresolved+=1;domain.proposedUnresolved+=1;partitionStats.proposedUnresolved+=1;}
    domains.set(domainId,domain);
    partitions.set(partition,partitionStats);
    caseResults.push(Object.freeze({caseId:entry.caseId,baseStatus:before.status,proposedStatus:after.status}));
  }
  const status=regressions>0?'regressed':recoveries>0?'improved':'non-regressing';
  const generalization=Object.freeze({
    distinctApplications:applications.size,
    distinctProviderFamilies:providers.size,
    domains:Object.freeze([...domains.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([domainId,value])=>Object.freeze({domainId,...value}))),
    partitions:Object.freeze((['development','holdout'] as const).filter((partition)=>partitions.has(partition)).map((partition)=>{
      const value=partitions.get(partition)!;
      return Object.freeze({partition,cases:value.cases,recoveries:value.recoveries,regressions:value.regressions,stableReady:value.stableReady,proposedUnresolved:value.proposedUnresolved,distinctApplications:value.applications.size,distinctProviderFamilies:value.providers.size});
    })),
  });
  return Object.freeze({
    status,cases:cases.length,recoveries,regressions,stableReady,proposedUnresolved,generalization,
    caseResults:Object.freeze(caseResults),promotionEligible:false as const,authorityGranted:false as const,
  });
}
