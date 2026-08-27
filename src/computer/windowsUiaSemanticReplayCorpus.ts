import { createHash } from 'node:crypto';
import { captureWindowsUiaCachedObservation } from './windowsUiaContract.js';
import type { WindowsUiaSemanticOfflineReplayCase } from './windowsUiaSemanticOfflineEvaluation.js';

const TOKEN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MAX_CASES=256;
const MAX_INPUTS=64;
const MAX_INPUT_BYTES=16_384;
const encoder=new TextEncoder();

function canonicalInputs(value:WindowsUiaSemanticOfflineReplayCase['inputs']):Readonly<Record<string,string|number>> {
  if(value===undefined)return Object.freeze({});
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('windows-uia-semantic-replay-corpus-inputs-invalid');
  const prototype=Object.getPrototypeOf(value);
  if(prototype!==Object.prototype&&prototype!==null)throw new Error('windows-uia-semantic-replay-corpus-inputs-invalid');
  const keys=Object.keys(value).sort();
  if(keys.length>MAX_INPUTS)throw new Error('windows-uia-semantic-replay-corpus-inputs-invalid');
  const captured:Record<string,string|number>=Object.create(null);
  for(const key of keys){
    if(!TOKEN.test(key))throw new Error('windows-uia-semantic-replay-corpus-input-key-invalid');
    const descriptor=Object.getOwnPropertyDescriptor(value,key);
    if(!descriptor||!('value'in descriptor)||descriptor.get!==undefined||descriptor.set!==undefined||!descriptor.enumerable)
      throw new Error('windows-uia-semantic-replay-corpus-inputs-invalid');
    const entry=descriptor.value;
    if(typeof entry==='string'){
      if(entry.includes('\0')||encoder.encode(entry).byteLength>MAX_INPUT_BYTES)throw new Error('windows-uia-semantic-replay-corpus-input-value-invalid');
      captured[key]=entry;
    }else if(typeof entry==='number'&&Number.isFinite(entry))captured[key]=entry;
    else throw new Error('windows-uia-semantic-replay-corpus-input-value-invalid');
  }
  return Object.freeze(captured);
}

/**
 * Canonical identity for one exact bounded offline replay corpus. Ordering is not
 * identity-bearing: cases are sorted by caseId before hashing. The digest conveys
 * no promotion or execution authority; it only makes an evaluation reproducible.
 */
export function digestWindowsUiaSemanticReplayCorpus(cases:readonly WindowsUiaSemanticOfflineReplayCase[]):string {
  if(!Array.isArray(cases)||cases.length===0||cases.length>MAX_CASES)throw new Error('windows-uia-semantic-replay-corpus-cases-invalid');
  const seen=new Set<string>();
  const canonical=cases.map((entry)=>{
    if(!entry||typeof entry!=='object'||typeof entry.caseId!=='string'||!TOKEN.test(entry.caseId)||seen.has(entry.caseId))
      throw new Error('windows-uia-semantic-replay-corpus-case-id-invalid');
    seen.add(entry.caseId);
    if(entry.applicationId!==undefined&&(!TOKEN.test(entry.applicationId)))throw new Error('windows-uia-semantic-replay-corpus-application-id-invalid');
    if(entry.providerFamily!==undefined&&(!TOKEN.test(entry.providerFamily)))throw new Error('windows-uia-semantic-replay-corpus-provider-family-invalid');
    if(entry.partition!==undefined&&entry.partition!=='development'&&entry.partition!=='holdout')throw new Error('windows-uia-semantic-replay-corpus-partition-invalid');
    const observation=captureWindowsUiaCachedObservation(entry.observation);
    if(!observation)throw new Error('windows-uia-semantic-replay-corpus-observation-invalid');
    return Object.freeze({
      caseId:entry.caseId,
      applicationId:entry.applicationId??null,
      providerFamily:entry.providerFamily??null,
      partition:entry.partition??'development',
      observation,
      inputs:canonicalInputs(entry.inputs),
    });
  }).sort((a,b)=>a.caseId.localeCompare(b.caseId));
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical),'utf8').digest('hex')}`;
}
