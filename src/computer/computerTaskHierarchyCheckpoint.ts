import { createHash, timingSafeEqual } from 'node:crypto';
import {
  COMPUTER_TASK_HIERARCHY_MAX_AUTHORITY_REFS,
  COMPUTER_TASK_HIERARCHY_MAX_DEPTH,
  COMPUTER_TASK_HIERARCHY_MAX_EXECUTIONS,
  COMPUTER_TASK_HIERARCHY_MAX_TOTAL_STEPS,
  ComputerTaskHierarchyLedger,
  type ComputerTaskHierarchyExecution,
  type ComputerTaskHierarchyLimits,
  type ComputerTaskHierarchySnapshot,
} from './computerTaskHierarchy.js';
import { computerTaskProgramHash } from './computerTaskCheckpoint.js';
import { snapshotComputerTaskProgram, type ComputerTaskProgram } from './computerTask.js';
import type { ComputerTaskTerminalStatus } from './computerTaskRuntime.js';

export const COMPUTER_TASK_HIERARCHY_CHECKPOINT_VERSION=1 as const;
export const COMPUTER_TASK_HIERARCHY_CHECKPOINT_FORMAT='browser-automation/computer-task-hierarchy-checkpoint' as const;
export const COMPUTER_TASK_HIERARCHY_CHECKPOINT_MAX_BYTES=128*1024;
export const COMPUTER_TASK_HIERARCHY_CHECKPOINT_STORE_MAX_REVISION=1_000_000_000;

export interface ComputerTaskHierarchyCheckpoint extends ComputerTaskHierarchySnapshot {
  readonly version:typeof COMPUTER_TASK_HIERARCHY_CHECKPOINT_VERSION;
}

interface ComputerTaskHierarchyCheckpointEnvelope {
  readonly format:typeof COMPUTER_TASK_HIERARCHY_CHECKPOINT_FORMAT;
  readonly integrity:{readonly algorithm:'sha256';readonly digest:string};
  readonly payload:ComputerTaskHierarchyCheckpoint;
}

export interface ComputerTaskHierarchyCheckpointStoreEntry {
  readonly rootExecutionId:string;
  readonly revision:number;
  readonly checkpoint:ComputerTaskHierarchyCheckpoint;
}

export type ComputerTaskHierarchyCheckpointCommitResult =
  | {readonly status:'committed';readonly revision:number}
  | {readonly status:'conflict';readonly currentRevision:number};

export interface ComputerTaskHierarchyCheckpointStore {
  read(rootExecutionId:string):Promise<ComputerTaskHierarchyCheckpointStoreEntry|undefined>;
  compareAndSwap(rootExecutionId:string,expectedRevision:number,checkpoint:ComputerTaskHierarchyCheckpoint):Promise<ComputerTaskHierarchyCheckpointCommitResult>;
}

const EXECUTION_ID=/^[0-9a-f]{32,64}$/;
const SHA256=/^[0-9a-f]{64}$/;
const AUTHORITY_REF=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const TERMINAL_STATUSES:readonly ComputerTaskTerminalStatus[]=[
  'completed','rejected','unsupported','failed','stale-target','verification-pending',
  'verification-mismatch','unverified','unknown-dispatch','reconciliation-required','suspended',
];

function isPlainObject(value:unknown):value is Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const prototype=Object.getPrototypeOf(value);
  return prototype===Object.prototype||prototype===null;
}

function exactKeys(value:Record<string,unknown>,keys:readonly string[],label:string):void{
  const actual=Object.keys(value).sort();
  const expected=[...keys].sort();
  if(actual.length!==expected.length||actual.some((key,index)=>key!==expected[index]))throw new Error(`${label} schema invalid`);
}

function boundedInt(value:unknown,min:number,max:number,label:string):number{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<min||value>max)throw new Error(`${label} invalid`);
  return value;
}

function boundedIdentifier(value:unknown,max=128):value is string{
  return typeof value==='string'&&value.length>0&&Buffer.byteLength(value,'utf8')<=max&&!/[\r\n\0]/.test(value);
}

function canonicalJson(value:unknown):string{
  if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'){
    if(!Number.isFinite(value))throw new Error('computer task hierarchy checkpoint contains non-finite number');
    return JSON.stringify(Object.is(value,-0)?0:value);
  }
  if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;
  if(!isPlainObject(value))throw new Error('computer task hierarchy checkpoint contains non-JSON value');
  return `{${Object.keys(value).sort().filter((key)=>value[key]!==undefined).map((key)=>`${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value:string):string{return createHash('sha256').update(value,'utf8').digest('hex');}

function freezeExecution(execution:ComputerTaskHierarchyExecution):ComputerTaskHierarchyExecution{
  return Object.freeze({
    executionId:execution.executionId,
    ...(execution.parentExecutionId!==undefined?{parentExecutionId:execution.parentExecutionId}:{}),
    depth:execution.depth,
    programId:execution.programId,
    programHash:execution.programHash,
    maxSteps:execution.maxSteps,
    stepsExecuted:execution.stepsExecuted,
    authorityGrantRefs:Object.freeze([...execution.authorityGrantRefs]),
    ...(execution.lastStatus!==undefined?{lastStatus:execution.lastStatus}:{}),
  });
}

function freezeCheckpoint(checkpoint:ComputerTaskHierarchyCheckpoint):ComputerTaskHierarchyCheckpoint{
  return Object.freeze({
    version:COMPUTER_TASK_HIERARCHY_CHECKPOINT_VERSION,
    rootExecutionId:checkpoint.rootExecutionId,
    limits:Object.freeze({...checkpoint.limits}),
    totalStepsExecuted:checkpoint.totalStepsExecuted,
    executions:Object.freeze(checkpoint.executions.map(freezeExecution)),
  });
}

export function validateComputerTaskHierarchyCheckpoint(value:unknown):asserts value is ComputerTaskHierarchyCheckpoint{
  if(!isPlainObject(value))throw new Error('invalid computer task hierarchy checkpoint');
  exactKeys(value,['version','rootExecutionId','limits','totalStepsExecuted','executions'],'computer task hierarchy checkpoint');
  if(value.version!==COMPUTER_TASK_HIERARCHY_CHECKPOINT_VERSION)throw new Error('unsupported computer task hierarchy checkpoint version');
  if(typeof value.rootExecutionId!=='string'||!EXECUTION_ID.test(value.rootExecutionId))throw new Error('computer task hierarchy checkpoint root invalid');
  if(!isPlainObject(value.limits))throw new Error('computer task hierarchy checkpoint limits invalid');
  exactKeys(value.limits,['maxDepth','maxExecutions','maxTotalSteps'],'computer task hierarchy checkpoint limits');
  const limits:ComputerTaskHierarchyLimits={
    maxDepth:boundedInt(value.limits.maxDepth,1,COMPUTER_TASK_HIERARCHY_MAX_DEPTH,'computer task hierarchy checkpoint maxDepth'),
    maxExecutions:boundedInt(value.limits.maxExecutions,1,COMPUTER_TASK_HIERARCHY_MAX_EXECUTIONS,'computer task hierarchy checkpoint maxExecutions'),
    maxTotalSteps:boundedInt(value.limits.maxTotalSteps,1,COMPUTER_TASK_HIERARCHY_MAX_TOTAL_STEPS,'computer task hierarchy checkpoint maxTotalSteps'),
  };
  const total=boundedInt(value.totalStepsExecuted,0,limits.maxTotalSteps,'computer task hierarchy checkpoint total steps');
  if(!Array.isArray(value.executions)||value.executions.length<1||value.executions.length>limits.maxExecutions)throw new Error('computer task hierarchy checkpoint executions invalid');
  const executions=new Map<string,ComputerTaskHierarchyExecution>();
  let sum=0;
  for(const raw of value.executions){
    if(!isPlainObject(raw))throw new Error('computer task hierarchy checkpoint execution invalid');
    const allowed=['executionId','depth','programId','programHash','maxSteps','stepsExecuted','authorityGrantRefs'];
    if(raw.parentExecutionId!==undefined)allowed.push('parentExecutionId');
    if(raw.lastStatus!==undefined)allowed.push('lastStatus');
    exactKeys(raw,allowed,'computer task hierarchy checkpoint execution');
    if(typeof raw.executionId!=='string'||!EXECUTION_ID.test(raw.executionId)||executions.has(raw.executionId))throw new Error('computer task hierarchy checkpoint execution id invalid');
    if(raw.parentExecutionId!==undefined&&(typeof raw.parentExecutionId!=='string'||!EXECUTION_ID.test(raw.parentExecutionId)))throw new Error('computer task hierarchy checkpoint parent id invalid');
    const depth=boundedInt(raw.depth,0,limits.maxDepth,'computer task hierarchy checkpoint depth');
    if(!boundedIdentifier(raw.programId))throw new Error('computer task hierarchy checkpoint program id invalid');
    if(typeof raw.programHash!=='string'||!SHA256.test(raw.programHash))throw new Error('computer task hierarchy checkpoint program hash invalid');
    const maxSteps=boundedInt(raw.maxSteps,1,limits.maxTotalSteps,'computer task hierarchy checkpoint execution maxSteps');
    const stepsExecuted=boundedInt(raw.stepsExecuted,0,maxSteps,'computer task hierarchy checkpoint execution steps');
    if(!Array.isArray(raw.authorityGrantRefs)||raw.authorityGrantRefs.length>COMPUTER_TASK_HIERARCHY_MAX_AUTHORITY_REFS)throw new Error('computer task hierarchy checkpoint authority refs invalid');
    const refs:string[]=[];
    for(const ref of raw.authorityGrantRefs){
      if(typeof ref!=='string'||!AUTHORITY_REF.test(ref)||refs.includes(ref))throw new Error('computer task hierarchy checkpoint authority ref invalid');
      refs.push(ref);
    }
    if(raw.lastStatus!==undefined&&(typeof raw.lastStatus!=='string'||!TERMINAL_STATUSES.includes(raw.lastStatus as ComputerTaskTerminalStatus)))throw new Error('computer task hierarchy checkpoint status invalid');
    if(stepsExecuted>0&&raw.lastStatus===undefined)throw new Error('computer task hierarchy checkpoint progress lacks status');
    const execution:ComputerTaskHierarchyExecution={
      executionId:raw.executionId,
      ...(raw.parentExecutionId!==undefined?{parentExecutionId:raw.parentExecutionId}:{}),
      depth,
      programId:raw.programId,
      programHash:raw.programHash,
      maxSteps,
      stepsExecuted,
      authorityGrantRefs:refs,
      ...(raw.lastStatus!==undefined?{lastStatus:raw.lastStatus as ComputerTaskTerminalStatus}:{}),
    };
    executions.set(execution.executionId,execution);
    sum+=stepsExecuted;
  }
  if(sum!==total)throw new Error('computer task hierarchy checkpoint total steps inconsistent');
  const root=executions.get(value.rootExecutionId);
  if(!root||root.depth!==0||root.parentExecutionId!==undefined)throw new Error('computer task hierarchy checkpoint root topology invalid');
  for(const execution of executions.values()){
    if(execution.executionId===value.rootExecutionId)continue;
    if(execution.parentExecutionId===undefined)throw new Error('computer task hierarchy checkpoint child parent missing');
    const parent=executions.get(execution.parentExecutionId);
    if(!parent||execution.depth!==parent.depth+1)throw new Error('computer task hierarchy checkpoint topology invalid');
  }
}

export function createComputerTaskHierarchyCheckpoint(snapshot:ComputerTaskHierarchySnapshot):ComputerTaskHierarchyCheckpoint{
  const checkpoint:ComputerTaskHierarchyCheckpoint={version:COMPUTER_TASK_HIERARCHY_CHECKPOINT_VERSION,...snapshot};
  validateComputerTaskHierarchyCheckpoint(checkpoint);
  return freezeCheckpoint(checkpoint);
}

export function encodeComputerTaskHierarchyCheckpoint(checkpoint:ComputerTaskHierarchyCheckpoint):string{
  validateComputerTaskHierarchyCheckpoint(checkpoint);
  const payload=canonicalJson(checkpoint);
  const envelope:ComputerTaskHierarchyCheckpointEnvelope={format:COMPUTER_TASK_HIERARCHY_CHECKPOINT_FORMAT,integrity:{algorithm:'sha256',digest:sha256(payload)},payload:checkpoint};
  const encoded=canonicalJson(envelope);
  if(Buffer.byteLength(encoded,'utf8')>COMPUTER_TASK_HIERARCHY_CHECKPOINT_MAX_BYTES)throw new Error('computer task hierarchy checkpoint exceeds size limit');
  return encoded;
}

export function decodeComputerTaskHierarchyCheckpoint(encoded:string):ComputerTaskHierarchyCheckpoint{
  if(typeof encoded!=='string'||Buffer.byteLength(encoded,'utf8')>COMPUTER_TASK_HIERARCHY_CHECKPOINT_MAX_BYTES)throw new Error('computer task hierarchy checkpoint exceeds size limit');
  let parsed:unknown;
  try{parsed=JSON.parse(encoded);}catch{throw new Error('computer task hierarchy checkpoint malformed JSON');}
  if(!isPlainObject(parsed))throw new Error('computer task hierarchy checkpoint envelope invalid');
  exactKeys(parsed,['format','integrity','payload'],'computer task hierarchy checkpoint envelope');
  if(parsed.format!==COMPUTER_TASK_HIERARCHY_CHECKPOINT_FORMAT||!isPlainObject(parsed.integrity))throw new Error('computer task hierarchy checkpoint envelope invalid');
  exactKeys(parsed.integrity,['algorithm','digest'],'computer task hierarchy checkpoint integrity');
  if(parsed.integrity.algorithm!=='sha256'||typeof parsed.integrity.digest!=='string'||!SHA256.test(parsed.integrity.digest))throw new Error('computer task hierarchy checkpoint integrity invalid');
  validateComputerTaskHierarchyCheckpoint(parsed.payload);
  const expected=Buffer.from(sha256(canonicalJson(parsed.payload)),'hex');
  const actual=Buffer.from(parsed.integrity.digest,'hex');
  if(expected.length!==actual.length||!timingSafeEqual(expected,actual))throw new Error('computer task hierarchy checkpoint integrity mismatch');
  return freezeCheckpoint(parsed.payload);
}

function validRevision(value:number,allowZero:boolean):boolean{return Number.isSafeInteger(value)&&value>=(allowZero?0:1)&&value<=COMPUTER_TASK_HIERARCHY_CHECKPOINT_STORE_MAX_REVISION;}
function freezeStoreEntry(entry:ComputerTaskHierarchyCheckpointStoreEntry):ComputerTaskHierarchyCheckpointStoreEntry{return Object.freeze({rootExecutionId:entry.rootExecutionId,revision:entry.revision,checkpoint:entry.checkpoint});}

export function validateComputerTaskHierarchyCheckpointStoreEntry(value:unknown,rootExecutionId?:string):asserts value is ComputerTaskHierarchyCheckpointStoreEntry{
  if(!isPlainObject(value))throw new Error('computer task hierarchy checkpoint store entry invalid');
  exactKeys(value,['rootExecutionId','revision','checkpoint'],'computer task hierarchy checkpoint store entry');
  if(typeof value.rootExecutionId!=='string'||!EXECUTION_ID.test(value.rootExecutionId)||typeof value.revision!=='number'||!validRevision(value.revision,false))throw new Error('computer task hierarchy checkpoint store entry invalid');
  validateComputerTaskHierarchyCheckpoint(value.checkpoint);
  if(value.checkpoint.rootExecutionId!==value.rootExecutionId||(rootExecutionId!==undefined&&value.rootExecutionId!==rootExecutionId))throw new Error('computer task hierarchy checkpoint store root mismatch');
}

export async function loadComputerTaskHierarchyCheckpointStoreHead(store:ComputerTaskHierarchyCheckpointStore,rootExecutionId:string):Promise<ComputerTaskHierarchyCheckpointStoreEntry|undefined>{
  if(!EXECUTION_ID.test(rootExecutionId))throw new Error('computer task hierarchy root execution id invalid');
  const entry=await store.read(rootExecutionId);
  if(entry===undefined)return undefined;
  validateComputerTaskHierarchyCheckpointStoreEntry(entry,rootExecutionId);
  return freezeStoreEntry(entry);
}

export class InMemoryComputerTaskHierarchyCheckpointStore implements ComputerTaskHierarchyCheckpointStore{
  private readonly entries=new Map<string,ComputerTaskHierarchyCheckpointStoreEntry>();
  async read(rootExecutionId:string):Promise<ComputerTaskHierarchyCheckpointStoreEntry|undefined>{
    if(!EXECUTION_ID.test(rootExecutionId))throw new Error('computer task hierarchy root execution id invalid');
    const entry=this.entries.get(rootExecutionId);
    return entry?freezeStoreEntry(entry):undefined;
  }
  async compareAndSwap(rootExecutionId:string,expectedRevision:number,checkpoint:ComputerTaskHierarchyCheckpoint):Promise<ComputerTaskHierarchyCheckpointCommitResult>{
    if(!EXECUTION_ID.test(rootExecutionId)||!validRevision(expectedRevision,true))throw new Error('computer task hierarchy checkpoint store request invalid');
    validateComputerTaskHierarchyCheckpoint(checkpoint);
    if(checkpoint.rootExecutionId!==rootExecutionId)throw new Error('computer task hierarchy checkpoint store root mismatch');
    const current=this.entries.get(rootExecutionId);
    const currentRevision=current?.revision??0;
    if(currentRevision!==expectedRevision)return Object.freeze({status:'conflict',currentRevision});
    if(currentRevision>=COMPUTER_TASK_HIERARCHY_CHECKPOINT_STORE_MAX_REVISION)throw new Error('computer task hierarchy checkpoint store revision exhausted');
    const revision=currentRevision+1;
    this.entries.set(rootExecutionId,freezeStoreEntry({rootExecutionId,revision,checkpoint}));
    return Object.freeze({status:'committed',revision});
  }
}

export function restoreComputerTaskHierarchyLedger(checkpoint:ComputerTaskHierarchyCheckpoint,programs:ReadonlyMap<string,ComputerTaskProgram>):ComputerTaskHierarchyLedger{
  validateComputerTaskHierarchyCheckpoint(checkpoint);
  const rootState=checkpoint.executions.find((entry)=>entry.executionId===checkpoint.rootExecutionId)!;
  const rootProgram=programs.get(rootState.executionId);
  if(!rootProgram)throw new Error('computer task hierarchy restore root program missing');
  const rootSnapshot=snapshotComputerTaskProgram(rootProgram);
  if(rootSnapshot.id!==rootState.programId||computerTaskProgramHash(rootSnapshot)!==rootState.programHash)throw new Error('computer task hierarchy restore program mismatch');
  const ledger=new ComputerTaskHierarchyLedger({executionId:rootState.executionId,program:rootSnapshot,maxSteps:rootState.maxSteps,authorityGrantRefs:rootState.authorityGrantRefs},checkpoint.limits);
  const children=checkpoint.executions.filter((entry)=>entry.executionId!==checkpoint.rootExecutionId).sort((a,b)=>a.depth-b.depth);
  for(const state of children){
    const program=programs.get(state.executionId);
    if(!program)throw new Error('computer task hierarchy restore child program missing');
    const snapshot=snapshotComputerTaskProgram(program);
    if(snapshot.id!==state.programId||computerTaskProgramHash(snapshot)!==state.programHash)throw new Error('computer task hierarchy restore program mismatch');
    ledger.delegate({parentExecutionId:state.parentExecutionId!,childExecutionId:state.executionId,program:snapshot,maxSteps:state.maxSteps,authorityGrantRefs:state.authorityGrantRefs});
  }
  for(const state of checkpoint.executions){
    if(state.lastStatus!==undefined)ledger.recordRuntimeProgress(state.executionId,{stepsExecuted:state.stepsExecuted,status:state.lastStatus});
  }
  const restored=createComputerTaskHierarchyCheckpoint(ledger.snapshot());
  if(encodeComputerTaskHierarchyCheckpoint(restored)!==encodeComputerTaskHierarchyCheckpoint(checkpoint))throw new Error('computer task hierarchy restore mismatch');
  return ledger;
}
