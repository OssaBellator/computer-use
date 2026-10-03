import { digestWindowsUiaSemanticRecipeManifest, type WindowsUiaSemanticRecipeManifest } from './windowsUiaSemanticRecipeManifest.js';

const TOKEN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MAX_ALTERNATIVES=16;
const MAX_EVIDENCE=128;
const MAX_TEXT_BYTES=512;
const encoder=new TextEncoder();

export interface WindowsUiaSemanticLocatorCorrection {
  readonly correctionId:string;
  readonly evidenceIds:readonly string[];
  /** Exact provider automation-id alternatives to add; existing alternatives are never removed. */
  readonly addAutomationIds?:readonly string[];
  /** Exact semantic-name alternatives to add; existing alternatives are never removed. */
  readonly addNames?:readonly string[];
}

export type WindowsUiaSemanticCorrectionCompilation =
  | Readonly<{
      status:'compiled';
      correctionId:string;
      proposedManifest:WindowsUiaSemanticRecipeManifest;
      proposedManifestDigest:string;
      authorityGranted:false;
      promotionApproved:false;
      evidence:readonly string[];
    }>
  | Readonly<{
      status:'rejected';
      correctionId:string;
      reason:string;
      authorityGranted:false;
      promotionApproved:false;
      evidence:readonly string[];
    }>;

function boundedText(value:unknown):value is string {
  return typeof value==='string'&&value.length>0&&!value.includes('\0')&&encoder.encode(value).byteLength<=MAX_TEXT_BYTES;
}
function validEvidence(values:unknown):values is readonly string[] {
  return Array.isArray(values)&&values.length>0&&values.length<=MAX_EVIDENCE&&
    values.every((value)=>typeof value==='string'&&TOKEN.test(value))&&new Set(values).size===values.length;
}
function validAlternatives(values:unknown):values is readonly string[] {
  return Array.isArray(values)&&values.length>0&&values.length<=MAX_ALTERNATIVES&&values.every(boundedText)&&new Set(values).size===values.length;
}
function mergeExact(existing:readonly string[]|undefined,added:readonly string[]|undefined):readonly string[]|undefined {
  if(existing===undefined&&added===undefined)return undefined;
  return Object.freeze([...new Set([...(existing??[]),...(added??[])])]);
}
function mergeNames(existing:readonly string[]|undefined,added:readonly string[]|undefined):readonly string[]|undefined {
  if(existing===undefined&&added===undefined)return undefined;
  const result:string[]=[];
  const seen=new Set<string>();
  for(const value of [...(existing??[]),...(added??[])]){
    const key=value.toLocaleLowerCase('en-US');
    if(seen.has(key))continue;
    seen.add(key);
    result.push(value);
  }
  return Object.freeze(result);
}

/**
 * Compile one bounded additive locator correction into an immutable child recipe
 * manifest. This is an offline learning primitive only: it can add exact locator
 * alternatives but cannot change the semantic action, control/pattern constraints,
 * authority, credentials, grants, effect class, promotion state, or dispatch path.
 */
export function compileWindowsUiaSemanticLocatorCorrection(
  base:WindowsUiaSemanticRecipeManifest,
  correction:WindowsUiaSemanticLocatorCorrection,
):WindowsUiaSemanticCorrectionCompilation {
  const correctionId=correction&&typeof correction==='object'&&typeof correction.correctionId==='string'&&TOKEN.test(correction.correctionId)
    ?correction.correctionId:'invalid';
  const reject=(reason:string)=>Object.freeze({
    status:'rejected' as const,correctionId,reason,authorityGranted:false as const,promotionApproved:false as const,
    evidence:Object.freeze([`windows-uia-semantic-correction-compiler-${reason}`]),
  });
  if(correctionId==='invalid'||!validEvidence(correction.evidenceIds))return reject('metadata-invalid');
  if(correction.addAutomationIds!==undefined&&!validAlternatives(correction.addAutomationIds))return reject('automation-ids-invalid');
  if(correction.addNames!==undefined&&!validAlternatives(correction.addNames))return reject('names-invalid');
  if(correction.addAutomationIds===undefined&&correction.addNames===undefined)return reject('no-change');

  let baseDigest:string;
  try{baseDigest=digestWindowsUiaSemanticRecipeManifest(base);}catch{return reject('base-manifest-invalid');}
  const locator=base.recipe.locator;
  const automationIds=mergeExact(locator.automationIds,correction.addAutomationIds);
  const names=mergeNames(locator.names,correction.addNames);
  if((automationIds?.length??0)>MAX_ALTERNATIVES)return reject('automation-ids-overflow');
  if((names?.length??0)>MAX_ALTERNATIVES)return reject('names-overflow');
  const automationChanged=(automationIds?.length??0)!==(locator.automationIds?.length??0);
  const namesChanged=(names?.length??0)!==(locator.names?.length??0);
  if(!automationChanged&&!namesChanged)return reject('no-change');

  const evidenceIds=Object.freeze([...new Set([...base.evidenceIds,...correction.evidenceIds])]);
  if(evidenceIds.length>MAX_EVIDENCE)return reject('evidence-overflow');
  const proposedManifest:WindowsUiaSemanticRecipeManifest=Object.freeze({
    schemaVersion:1,
    revision:base.revision+1,
    parentDigest:baseDigest,
    evidenceIds,
    recipe:Object.freeze({
      id:base.recipe.id,
      locator:Object.freeze({
        id:locator.id,
        ...(automationIds!==undefined?{automationIds}:{}),
        ...(names!==undefined?{names}:{}),
        controlTypes:Object.freeze([...locator.controlTypes]),
        ...(locator.requiredPatterns!==undefined?{requiredPatterns:Object.freeze([...locator.requiredPatterns])}:{}),
        ...(locator.requireEnabled!==undefined?{requireEnabled:locator.requireEnabled}:{}),
        ...(locator.includeOffscreen!==undefined?{includeOffscreen:locator.includeOffscreen}:{}),
      }),
      action:Object.freeze({...base.recipe.action}),
    }),
  });
  let proposedManifestDigest:string;
  try{proposedManifestDigest=digestWindowsUiaSemanticRecipeManifest(proposedManifest);}catch{return reject('proposed-manifest-invalid');}
  return Object.freeze({
    status:'compiled' as const,correctionId,proposedManifest,proposedManifestDigest,
    authorityGranted:false as const,promotionApproved:false as const,
    evidence:Object.freeze(['windows-uia-semantic-correction-compiler-additive-locator-only','windows-uia-semantic-correction-compiler-no-authority']),
  });
}
