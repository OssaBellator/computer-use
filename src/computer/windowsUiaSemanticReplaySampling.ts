import type { WindowsUiaSemanticOfflineReplayCase } from './windowsUiaSemanticOfflineEvaluation.js';

const TOKEN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MAX_CASES=256;

export interface WindowsUiaSemanticReplaySamplingResult {
  readonly originalCases:number;
  readonly selectedCases:number;
  readonly maxCasesPerDomain:number;
  readonly cases:readonly WindowsUiaSemanticOfflineReplayCase[];
  readonly domains:readonly Readonly<{domainId:string;available:number;selected:number;dropped:number}>[];
  readonly thresholdApplied:false;
  readonly promotionEligible:false;
  readonly authorityGranted:false;
}

function domainId(entry:WindowsUiaSemanticOfflineReplayCase):string {
  return `${entry.partition??'development'}:${entry.applicationId??'unknown-app'}:${entry.providerFamily??'unknown-provider'}`;
}

/**
 * Deterministically cap cases per partition/application/provider replay domain.
 * The cap is a diagnostic sampling budget, not an approved quality threshold.
 */
export function selectWindowsUiaSemanticBalancedReplayCases(
  cases:readonly WindowsUiaSemanticOfflineReplayCase[],
  maxCasesPerDomain:number,
):WindowsUiaSemanticReplaySamplingResult {
  if(!Array.isArray(cases)||cases.length===0||cases.length>MAX_CASES||!Number.isSafeInteger(maxCasesPerDomain)||maxCasesPerDomain<1||maxCasesPerDomain>MAX_CASES)
    throw new Error('windows-uia-semantic-replay-sampling-invalid');
  const seen=new Set<string>();
  const groups=new Map<string,WindowsUiaSemanticOfflineReplayCase[]>();
  for(const entry of cases){
    if(!entry||typeof entry!=='object'||typeof entry.caseId!=='string'||!TOKEN.test(entry.caseId)||seen.has(entry.caseId))
      throw new Error('windows-uia-semantic-replay-sampling-case-id-invalid');
    seen.add(entry.caseId);
    if(entry.applicationId!==undefined&&!TOKEN.test(entry.applicationId))throw new Error('windows-uia-semantic-replay-sampling-application-id-invalid');
    if(entry.providerFamily!==undefined&&!TOKEN.test(entry.providerFamily))throw new Error('windows-uia-semantic-replay-sampling-provider-family-invalid');
    if(entry.partition!==undefined&&entry.partition!=='development'&&entry.partition!=='holdout')throw new Error('windows-uia-semantic-replay-sampling-partition-invalid');
    const key=domainId(entry);
    const values=groups.get(key)??[];
    values.push(entry);
    groups.set(key,values);
  }
  const selected:WindowsUiaSemanticOfflineReplayCase[]=[];
  const domains:Array<{domainId:string;available:number;selected:number;dropped:number}>=[];
  for(const key of [...groups.keys()].sort()){
    const available=[...groups.get(key)!].sort((a,b)=>a.caseId.localeCompare(b.caseId));
    const chosen=available.slice(0,maxCasesPerDomain);
    selected.push(...chosen);
    domains.push(Object.freeze({domainId:key,available:available.length,selected:chosen.length,dropped:available.length-chosen.length}));
  }
  return Object.freeze({
    originalCases:cases.length,selectedCases:selected.length,maxCasesPerDomain,
    cases:Object.freeze(selected),domains:Object.freeze(domains),
    thresholdApplied:false as const,promotionEligible:false as const,authorityGranted:false as const,
  });
}
