import type {
  ComputerActionIdempotency,
  ComputerActionRequest,
  ComputerActionResult,
  ComputerEffectClass,
  ComputerEntityRef,
  ComputerEnvironmentAdapter,
  ComputerEnvironmentAdapterDescriptor,
  ComputerObservationEnvelope,
  ComputerObservationRequest,
} from './environmentAdapter.js';

export const LOCAL_COMPUTE_CAPABILITY = 'local-compute.run';
export const LOCAL_COMPUTE_EFFECTS = [
  'pure-read-only',
  'local-artifact-creation',
  'process-execution',
  'external-network',
  'system-modification',
] as const;
export type LocalComputeEffect = typeof LOCAL_COMPUTE_EFFECTS[number];
export type AllowedLocalComputeEffect = Extract<LocalComputeEffect, 'pure-read-only'|'local-artifact-creation'>;
export type LocalComputeExecutionState = 'accepted'|'running'|'completed'|'failed'|'timed-out'|'output-limited'|'unknown';
export type LocalComputeJson = null|boolean|number|string|LocalComputeJson[]|{[key:string]:LocalComputeJson};

export interface LocalComputeIdentity { jobId:string; generation:number }
export interface LocalComputeArtifactIdentity {
  artifactId:string;
  generation:number;
  contentHash:string;
  byteLength:number;
  shape:string;
  state:'committed';
}
export interface LocalComputeResourceLimits {
  timeBudgetMs:number;
  maxInputBytes:number;
  maxOutputBytes:number;
  maxDiagnosticBytes:number;
  memoryBytesHint?:number;
}
export interface LocalComputeOperationContext {
  readonly signal:AbortSignal;
  readonly limits:Readonly<LocalComputeResourceLimits>;
  diagnostic(code:string):void;
}
export interface LocalComputeOperationDefinition<I extends LocalComputeJson = LocalComputeJson, O extends LocalComputeJson = LocalComputeJson> {
  id:string;
  effect:LocalComputeEffect;
  execute(input:I, context:LocalComputeOperationContext):O|Promise<O>;
}
export interface LocalComputeJobRequest {
  job:LocalComputeIdentity;
  operation:string;
  input:LocalComputeJson;
  limits?:Partial<LocalComputeResourceLimits>;
  expectedInputArtifactId?:string;
}
export interface LocalComputeJobSnapshot {
  identity:LocalComputeIdentity;
  operation:string;
  effect:AllowedLocalComputeEffect;
  inputArtifact:LocalComputeArtifactIdentity;
  outputArtifact?:LocalComputeArtifactIdentity;
  executionState:LocalComputeExecutionState;
  diagnostics:readonly string[];
}
export interface LocalComputeAdapterOptions {
  id?:string;
  operations:readonly LocalComputeOperationDefinition[];
  ambiguousDispatchOperationIds?:readonly string[];
}

const DEFAULT_LIMITS:LocalComputeResourceLimits = Object.freeze({
  timeBudgetMs:5_000,
  maxInputBytes:256*1024,
  maxOutputBytes:256*1024,
  maxDiagnosticBytes:4*1024,
  memoryBytesHint:64*1024*1024,
});
const MAX_LIMITS:LocalComputeResourceLimits = Object.freeze({
  timeBudgetMs:60_000,
  maxInputBytes:4*1024*1024,
  maxOutputBytes:4*1024*1024,
  maxDiagnosticBytes:64*1024,
  memoryBytesHint:2*1024*1024*1024,
});
const ID=/^[a-z0-9][a-z0-9._:-]{0,127}$/;
const DIAGNOSTIC=/^[a-z0-9][a-z0-9._:-]{0,63}$/;

function bytes(value:string):number{return new TextEncoder().encode(value).byteLength}
function stable(value:LocalComputeJson):string{
  if(value===null)return 'null';
  if(typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
  if(typeof value==='number'){
    if(!Number.isFinite(value)) throw new Error('non-finite-number');
    return Object.is(value,-0)?'0':JSON.stringify(value);
  }
  if(Array.isArray(value))return `[${value.map(stable).join(',')}]`;
  const keys=Object.keys(value).sort();
  return `{${keys.map(k=>`${JSON.stringify(k)}:${stable(value[k]!)}`).join(',')}}`;
}
function hashText(text:string):string{
  let h1=0x811c9dc5,h2=0x9e3779b9;
  for(const b of new TextEncoder().encode(text)){
    h1=Math.imul(h1^b,0x01000193)>>>0;
    h2=(Math.imul(h2^b,0x85ebca6b)+0x165667b1)>>>0;
  }
  return `fnv64-${h1.toString(16).padStart(8,'0')}${h2.toString(16).padStart(8,'0')}`;
}
function shape(value:LocalComputeJson):string{
  if(value===null)return 'null';
  if(Array.isArray(value))return `array:${value.length}`;
  if(typeof value==='object')return `object:${Object.keys(value).length}`;
  return typeof value;
}
function artifact(value:LocalComputeJson,generation=0):LocalComputeArtifactIdentity{
  const encoded=stable(value); const contentHash=hashText(encoded);
  return Object.freeze({artifactId:`artifact:${contentHash}`,generation,contentHash,byteLength:bytes(encoded),shape:shape(value),state:'committed'});
}
function validIdentity(job:LocalComputeIdentity):boolean{return ID.test(job.jobId)&&Number.isSafeInteger(job.generation)&&job.generation>=0}
function resolveLimits(partial:Partial<LocalComputeResourceLimits>|undefined):LocalComputeResourceLimits|null{
  const result={...DEFAULT_LIMITS,...partial};
  for(const key of ['timeBudgetMs','maxInputBytes','maxOutputBytes','maxDiagnosticBytes'] as const){
    const n=result[key]; if(!Number.isSafeInteger(n)||n<1||n>MAX_LIMITS[key]) return null;
  }
  if(result.memoryBytesHint!==undefined&&(!Number.isSafeInteger(result.memoryBytesHint)||result.memoryBytesHint<1||result.memoryBytesHint>MAX_LIMITS.memoryBytesHint!))return null;
  return result;
}
function expectedRequestSemantics(effect:AllowedLocalComputeEffect):{effect:ComputerEffectClass;idempotency:ComputerActionIdempotency}{
  return effect==='pure-read-only'?{effect:'observe-only',idempotency:'read-only'}:{effect:'local-reversible',idempotency:'non-idempotent'};
}
function freezeSnapshot(snapshot:LocalComputeJobSnapshot):LocalComputeJobSnapshot{return Object.freeze({...snapshot,identity:Object.freeze({...snapshot.identity}),diagnostics:Object.freeze([...snapshot.diagnostics])})}

export class LocalComputeAdapter implements ComputerEnvironmentAdapter {
  readonly descriptor:ComputerEnvironmentAdapterDescriptor;
  private readonly operations=new Map<string,LocalComputeOperationDefinition>();
  private readonly ambiguous=new Set<string>();
  private readonly jobs=new Map<string,LocalComputeJobSnapshot>();
  private readonly latestGeneration=new Map<string,number>();
  private readonly artifacts=new Map<string,LocalComputeJson>();
  private sequence=0;

  constructor(options:LocalComputeAdapterOptions){
    const id=options.id??'local-compute';
    if(!ID.test(id))throw new Error('invalid local compute adapter id');
    for(const operation of options.operations){
      if(!ID.test(operation.id))throw new Error(`invalid local compute operation id: ${operation.id}`);
      if(operation.effect!=='pure-read-only'&&operation.effect!=='local-artifact-creation')throw new Error(`unsafe local compute operation effect: ${operation.effect}`);
      if(this.operations.has(operation.id))throw new Error(`duplicate local compute operation: ${operation.id}`);
      this.operations.set(operation.id,operation);
    }
    this.ambiguous=new Set(options.ambiguousDispatchOperationIds??[]);
    this.descriptor=Object.freeze({id,kind:'local-compute',version:'1',capabilities:Object.freeze([LOCAL_COMPUTE_CAPABILITY])});
  }

  artifactContent(ref:LocalComputeArtifactIdentity):LocalComputeJson|undefined{
    const value=this.artifacts.get(ref.artifactId); if(value===undefined)return undefined;
    const actual=artifact(value,ref.generation);
    return actual.contentHash===ref.contentHash&&actual.byteLength===ref.byteLength?value:undefined;
  }

  async observe(request:ComputerObservationRequest):Promise<ComputerObservationEnvelope>{
    if(request.adapterId!==this.descriptor.id||request.channel!=='compute')throw new Error('unsupported local compute observation');
    let snapshot:LocalComputeJobSnapshot|undefined;
    if(request.target){
      if(request.target.environment!=='local-compute'||request.target.kind!=='compute-job'||request.target.adapterId!==this.descriptor.id)throw new Error('invalid compute job target');
      snapshot=this.jobs.get(`${request.target.entityId}:${request.target.generation??0}`);
    }
    return {adapterId:this.descriptor.id,environment:'local-compute',channel:'compute',sequence:this.sequence++,complete:true,truncated:false,target:request.target,data:snapshot??null};
  }

  async act(request:ComputerActionRequest):Promise<ComputerActionResult>{
    if(request.adapterId!==this.descriptor.id||request.capability!==LOCAL_COMPUTE_CAPABILITY)return this.reject('compute-capability-rejected');
    const payload=this.parsePayload(request.payload); if(!payload)return this.reject('compute-request-invalid');
    const operation=this.operations.get(payload.operation); if(!operation)return this.reject('compute-operation-unregistered','unsupported');
    const expected=expectedRequestSemantics(operation.effect as AllowedLocalComputeEffect);
    if(request.effect!==expected.effect||request.idempotency!==expected.idempotency)return this.reject('compute-effect-mismatch');
    const limits=resolveLimits(payload.limits); if(!limits)return this.reject('compute-limits-invalid');
    let encoded:string;
    try{encoded=stable(payload.input)}catch{return this.reject('compute-input-invalid')}
    if(bytes(encoded)>limits.maxInputBytes)return this.reject('compute-input-limit');
    const inputArtifact=artifact(payload.input);
    if(payload.expectedInputArtifactId!==undefined&&payload.expectedInputArtifactId!==inputArtifact.artifactId)return this.reject('compute-input-artifact-mismatch');
    const latest=this.latestGeneration.get(payload.job.jobId);
    if(latest!==undefined&&payload.job.generation<latest)return this.reject('compute-job-stale');
    const key=`${payload.job.jobId}:${payload.job.generation}`;
    const known=this.jobs.get(key);
    if(known)return this.resultForKnown(known);
    this.latestGeneration.set(payload.job.jobId,payload.job.generation);
    let snapshot:LocalComputeJobSnapshot=freezeSnapshot({identity:payload.job,operation:operation.id,effect:operation.effect as AllowedLocalComputeEffect,inputArtifact,executionState:'accepted',diagnostics:[]});
    this.jobs.set(key,snapshot);
    if(this.ambiguous.has(operation.id)){
      snapshot=freezeSnapshot({...snapshot,executionState:'unknown',diagnostics:['compute-dispatch-ambiguous']}); this.jobs.set(key,snapshot);
      return {status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['compute-dispatch-ambiguous'],details:{job:snapshot}};
    }
    const diagnostics:string[]=[]; let diagnosticBytes=0;
    const controller=new AbortController();
    const context:LocalComputeOperationContext={signal:controller.signal,limits:Object.freeze({...limits}),diagnostic:(code)=>{
      if(!DIAGNOSTIC.test(code))return;
      const extra=bytes(code)+(diagnostics.length?1:0); if(diagnosticBytes+extra>limits.maxDiagnosticBytes)return;
      diagnostics.push(code); diagnosticBytes+=extra;
    }};
    snapshot=freezeSnapshot({...snapshot,executionState:'running'}); this.jobs.set(key,snapshot);
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{
      const timedOut=new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort('time-budget-exceeded');reject(new Error('compute-timeout'))},limits.timeBudgetMs)});
      const output=await Promise.race([Promise.resolve().then(()=>operation.execute(payload.input,context)),timedOut]);
      let outputEncoded:string; try{outputEncoded=stable(output)}catch{throw new Error('invalid-output')}
      if(bytes(outputEncoded)>limits.maxOutputBytes){
        snapshot=freezeSnapshot({...snapshot,executionState:'output-limited',diagnostics});this.jobs.set(key,snapshot);
        return {status:'failed',dispatch:'dispatched-once',verification:'rejected',evidence:['compute-output-limit'],details:{job:snapshot}};
      }
      const outputArtifact=artifact(output);
      if(operation.effect==='local-artifact-creation')this.artifacts.set(outputArtifact.artifactId,output);
      snapshot=freezeSnapshot({...snapshot,outputArtifact,executionState:'completed',diagnostics});this.jobs.set(key,snapshot);
      return {status:'completed',dispatch:'dispatched-once',verification:'verified',evidence:[operation.effect==='pure-read-only'?'compute-output-verified':'compute-artifact-verified'],details:operation.effect==='pure-read-only'?{job:snapshot,output}:{job:snapshot,artifact:outputArtifact}};
    }catch(error){
      const timeout=controller.signal.aborted;
      snapshot=freezeSnapshot({...snapshot,executionState:timeout?'timed-out':'failed',diagnostics});this.jobs.set(key,snapshot);
      return {status:'failed',dispatch:'dispatched-once',verification:'rejected',evidence:[timeout?'compute-timeout':'compute-execution-failed'],details:{job:snapshot}};
    }finally{if(timer!==undefined)clearTimeout(timer)}
  }

  private parsePayload(value:unknown):LocalComputeJobRequest|null{
    if(value===null||typeof value!=='object'||Array.isArray(value))return null;
    const record=value as Record<string,unknown>;
    const allowed=new Set(['job','operation','input','limits','expectedInputArtifactId']);
    if(Object.keys(record).some(k=>!allowed.has(k)))return null;
    if(typeof record.operation!=='string'||!ID.test(record.operation))return null;
    if(record.job===null||typeof record.job!=='object'||Array.isArray(record.job))return null;
    const job=record.job as Record<string,unknown>;
    if(Object.keys(job).some(k=>k!=='jobId'&&k!=='generation')||typeof job.jobId!=='string'||typeof job.generation!=='number'||!validIdentity(job as unknown as LocalComputeIdentity))return null;
    if(record.expectedInputArtifactId!==undefined&&(typeof record.expectedInputArtifactId!=='string'||!ID.test(record.expectedInputArtifactId.replace(/^artifact:/,''))))return null;
    if(record.limits!==undefined&&(record.limits===null||typeof record.limits!=='object'||Array.isArray(record.limits)))return null;
    try{stable(record.input as LocalComputeJson)}catch{return null}
    return value as LocalComputeJobRequest;
  }
  private reject(evidence:string,status:'rejected'|'unsupported'='rejected'):ComputerActionResult{return {status,dispatch:'not-dispatched',verification:'rejected',evidence:[evidence]}}
  private resultForKnown(snapshot:LocalComputeJobSnapshot):ComputerActionResult{
    if(snapshot.executionState==='unknown')return {status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['compute-known-dispatch-unknown'],details:{job:snapshot}};
    if(snapshot.executionState==='completed')return {status:'completed',dispatch:'dispatched-once',verification:'verified',evidence:['compute-known-job'],details:{job:snapshot}};
    return {status:'unknown',dispatch:'unknown',verification:'unverified',evidence:['compute-known-job-incomplete'],details:{job:snapshot}};
  }
}

export function localComputeJobEntity(adapterId:string,identity:LocalComputeIdentity):ComputerEntityRef{
  return {adapterId,environment:'local-compute',kind:'compute-job',entityId:identity.jobId,generation:identity.generation};
}
