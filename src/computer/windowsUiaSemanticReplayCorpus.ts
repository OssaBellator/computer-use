import { createHash } from 'node:crypto';
import { captureWindowsUiaCachedObservation, type WindowsUiaCachedObservation } from './windowsUiaContract.js';
import type { WindowsUiaSemanticRecipeInputs } from './windowsUiaSemanticRecipe.js';

const TOKEN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MAX_CASES=256;
const MAX_INPUTS=64;
const MAX_INPUT_BYTES=16_384;
const encoder=new TextEncoder();

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

export interface WindowsUiaSemanticCapturedReplayCase {
  readonly caseId:string;
  readonly applicationId?:string;
  readonly providerFamily?:string;
  readonly partition:'development'|'holdout';
  readonly observation:WindowsUiaCachedObservation;
  readonly inputs:Readonly<Record<string,string|number>>;
}

export interface WindowsUiaSemanticCapturedReplayCorpus {
  readonly digest:string;
  /** Captured cases preserve caller order; ordering is normalized only for digest identity. */
  readonly cases:readonly WindowsUiaSemanticCapturedReplayCase[];
}

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
 * Strictly capture one exact bounded replay corpus for both hashing and evaluation.
 * Cases retain caller order for result reporting; only digest identity sorts by caseId.
 */
export function captureWindowsUiaSemanticReplayCorpus(cases:readonly WindowsUiaSemanticOfflineReplayCase[]):WindowsUiaSemanticCapturedReplayCorpus {
  if(!Array.isArray(cases)||cases.length===0||cases.length>MAX_CASES)throw new Error('windows-uia-semantic-replay-corpus-cases-invalid');
  const seen=new Set<string>();
  const capturedCases=cases.map((entry)=>{
    if(!entry||typeof entry!=='object')throw new Error('windows-uia-semantic-replay-corpus-case-id-invalid');
    const caseId=entry.caseId;
    const applicationId=entry.applicationId;
    const providerFamily=entry.providerFamily;
    const partition=entry.partition??'development';
    const rawObservation=entry.observation;
    const rawInputs=entry.inputs;
    if(typeof caseId!=='string'||!TOKEN.test(caseId)||seen.has(caseId))throw new Error('windows-uia-semantic-replay-corpus-case-id-invalid');
    seen.add(caseId);
    if(applicationId!==undefined&&!TOKEN.test(applicationId))throw new Error('windows-uia-semantic-replay-corpus-application-id-invalid');
    if(providerFamily!==undefined&&!TOKEN.test(providerFamily))throw new Error('windows-uia-semantic-replay-corpus-provider-family-invalid');
    if(partition!=='development'&&partition!=='holdout')throw new Error('windows-uia-semantic-replay-corpus-partition-invalid');
    const observation=captureWindowsUiaCachedObservation(rawObservation);
    if(!observation)throw new Error('windows-uia-semantic-replay-corpus-observation-invalid');
    return Object.freeze({
      caseId,
      ...(applicationId!==undefined?{applicationId}:{}),
      ...(providerFamily!==undefined?{providerFamily}:{}),
      partition,
      observation,
      inputs:canonicalInputs(rawInputs),
    });
  });
  const canonical=capturedCases.map((entry)=>Object.freeze({
    caseId:entry.caseId,
    applicationId:entry.applicationId??null,
    providerFamily:entry.providerFamily??null,
    partition:entry.partition,
    observation:entry.observation,
    inputs:entry.inputs,
  })).sort((a,b)=>a.caseId.localeCompare(b.caseId));
  const digest=`sha256:${createHash('sha256').update(JSON.stringify(canonical),'utf8').digest('hex')}`;
  return Object.freeze({digest,cases:Object.freeze(capturedCases)});
}

/**
 * Canonical identity for one exact bounded offline replay corpus. Ordering is not
 * identity-bearing: cases are sorted by caseId before hashing. The digest conveys
 * no promotion or execution authority; it only makes an evaluation reproducible.
 */
export function digestWindowsUiaSemanticReplayCorpus(cases:readonly WindowsUiaSemanticOfflineReplayCase[]):string {
  return captureWindowsUiaSemanticReplayCorpus(cases).digest;
}
