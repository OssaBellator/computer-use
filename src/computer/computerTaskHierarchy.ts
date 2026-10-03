import { computerTaskProgramHash } from './computerTaskCheckpoint.js';
import { snapshotComputerTaskProgram, type ComputerTaskProgram } from './computerTask.js';
import type { ComputerTaskRunResult, ComputerTaskTerminalStatus } from './computerTaskRuntime.js';

export const COMPUTER_TASK_HIERARCHY_MAX_DEPTH = 8;
export const COMPUTER_TASK_HIERARCHY_MAX_EXECUTIONS = 256;
export const COMPUTER_TASK_HIERARCHY_MAX_TOTAL_STEPS = 1_000_000;
export const COMPUTER_TASK_HIERARCHY_MAX_AUTHORITY_REFS = 32;

export interface ComputerTaskHierarchyLimits {
  readonly maxDepth:number;
  readonly maxExecutions:number;
  readonly maxTotalSteps:number;
}

export interface ComputerTaskHierarchyExecution {
  readonly executionId:string;
  readonly parentExecutionId?:string;
  readonly depth:number;
  readonly programId:string;
  readonly programHash:string;
  readonly maxSteps:number;
  readonly stepsExecuted:number;
  readonly authorityGrantRefs:readonly string[];
  readonly lastStatus?:ComputerTaskTerminalStatus;
}

export interface ComputerTaskHierarchySnapshot {
  readonly rootExecutionId:string;
  readonly limits:ComputerTaskHierarchyLimits;
  readonly totalStepsExecuted:number;
  readonly executions:readonly ComputerTaskHierarchyExecution[];
}

export interface ComputerTaskHierarchyRoot {
  readonly executionId:string;
  readonly program:ComputerTaskProgram;
  readonly maxSteps:number;
  readonly authorityGrantRefs?:readonly string[];
}

export interface ComputerTaskHierarchyDelegation {
  readonly parentExecutionId:string;
  readonly childExecutionId:string;
  readonly program:ComputerTaskProgram;
  readonly maxSteps:number;
  /** Explicit authority references only. Parent authority is never copied implicitly. */
  readonly authorityGrantRefs?:readonly string[];
}

const EXECUTION_ID=/^[0-9a-f]{32,64}$/;
const AUTHORITY_REF=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;

function boundedPositive(value:number,max:number,label:string):number{
  if(!Number.isSafeInteger(value)||value<1||value>max)throw new Error(`${label} is invalid`);
  return value;
}

function captureAuthorityRefs(values:readonly string[]|undefined):readonly string[]{
  if(values===undefined)return Object.freeze([]);
  if(!Array.isArray(values)||values.length>COMPUTER_TASK_HIERARCHY_MAX_AUTHORITY_REFS)throw new Error('computer task hierarchy authority refs exceed bound');
  const out:string[]=[];
  for(const value of values){
    if(typeof value!=='string'||!AUTHORITY_REF.test(value)||out.includes(value))throw new Error('computer task hierarchy authority ref invalid');
    out.push(value);
  }
  return Object.freeze(out);
}

function captureLimits(limits:ComputerTaskHierarchyLimits):ComputerTaskHierarchyLimits{
  return Object.freeze({
    maxDepth:boundedPositive(limits.maxDepth,COMPUTER_TASK_HIERARCHY_MAX_DEPTH,'computer task hierarchy maxDepth'),
    maxExecutions:boundedPositive(limits.maxExecutions,COMPUTER_TASK_HIERARCHY_MAX_EXECUTIONS,'computer task hierarchy maxExecutions'),
    maxTotalSteps:boundedPositive(limits.maxTotalSteps,COMPUTER_TASK_HIERARCHY_MAX_TOTAL_STEPS,'computer task hierarchy maxTotalSteps'),
  });
}

function executionId(value:string):string{
  if(!EXECUTION_ID.test(value))throw new Error('computer task hierarchy execution id invalid');
  return value;
}

interface MutableExecution {
  executionId:string;
  parentExecutionId?:string;
  depth:number;
  programId:string;
  programHash:string;
  maxSteps:number;
  stepsExecuted:number;
  authorityGrantRefs:readonly string[];
  lastStatus?:ComputerTaskTerminalStatus;
}

function freezeExecution(value:MutableExecution):ComputerTaskHierarchyExecution{
  return Object.freeze({
    executionId:value.executionId,
    ...(value.parentExecutionId!==undefined?{parentExecutionId:value.parentExecutionId}:{}),
    depth:value.depth,
    programId:value.programId,
    programHash:value.programHash,
    maxSteps:value.maxSteps,
    stepsExecuted:value.stepsExecuted,
    authorityGrantRefs:value.authorityGrantRefs,
    ...(value.lastStatus!==undefined?{lastStatus:value.lastStatus}:{}),
  });
}

/**
 * Bounded parent/child execution ledger for long-horizon task decomposition.
 * It intentionally owns no computer authority and performs no actions. Every child
 * receives only explicitly supplied opaque authority references, while cumulative
 * runtime step counts roll up to one parent-owned global budget across resumes.
 */
export class ComputerTaskHierarchyLedger {
  private readonly executions=new Map<string,MutableExecution>();
  private readonly limits:ComputerTaskHierarchyLimits;
  private totalStepsExecuted=0;
  readonly rootExecutionId:string;

  constructor(root:ComputerTaskHierarchyRoot,limits:ComputerTaskHierarchyLimits){
    this.limits=captureLimits(limits);
    this.rootExecutionId=executionId(root.executionId);
    const program=snapshotComputerTaskProgram(root.program);
    const maxSteps=boundedPositive(root.maxSteps,this.limits.maxTotalSteps,'computer task hierarchy root maxSteps');
    this.executions.set(this.rootExecutionId,{
      executionId:this.rootExecutionId,
      depth:0,
      programId:program.id,
      programHash:computerTaskProgramHash(program),
      maxSteps,
      stepsExecuted:0,
      authorityGrantRefs:captureAuthorityRefs(root.authorityGrantRefs),
    });
  }

  delegate(request:ComputerTaskHierarchyDelegation):ComputerTaskHierarchyExecution{
    const parentId=executionId(request.parentExecutionId);
    const childId=executionId(request.childExecutionId);
    if(childId===parentId||this.executions.has(childId))throw new Error('computer task hierarchy child execution already exists');
    const parent=this.executions.get(parentId);
    if(!parent)throw new Error('computer task hierarchy parent execution missing');
    if(parent.lastStatus!==undefined&&parent.lastStatus!=='suspended')throw new Error('computer task hierarchy parent cannot delegate in current state');
    const depth=parent.depth+1;
    if(depth>this.limits.maxDepth)throw new Error('computer task hierarchy depth exhausted');
    if(this.executions.size>=this.limits.maxExecutions)throw new Error('computer task hierarchy execution count exhausted');
    const program=snapshotComputerTaskProgram(request.program);
    const maxSteps=boundedPositive(request.maxSteps,this.limits.maxTotalSteps,'computer task hierarchy child maxSteps');
    if(maxSteps>this.limits.maxTotalSteps-this.totalStepsExecuted)throw new Error('computer task hierarchy remaining global budget insufficient');
    const child:MutableExecution={
      executionId:childId,
      parentExecutionId:parentId,
      depth,
      programId:program.id,
      programHash:computerTaskProgramHash(program),
      maxSteps,
      stepsExecuted:0,
      // Deliberately no fallback to parent.authorityGrantRefs.
      authorityGrantRefs:captureAuthorityRefs(request.authorityGrantRefs),
    };
    this.executions.set(childId,child);
    return freezeExecution(child);
  }

  recordRuntimeProgress(
    executionIdValue:string,
    result:Pick<ComputerTaskRunResult,'stepsExecuted'|'status'>,
  ):ComputerTaskHierarchyExecution{
    const id=executionId(executionIdValue);
    const execution=this.executions.get(id);
    if(!execution)throw new Error('computer task hierarchy execution missing');
    if(!Number.isSafeInteger(result.stepsExecuted)||result.stepsExecuted<execution.stepsExecuted){
      throw new Error('computer task hierarchy runtime progress rolled back');
    }
    if(result.stepsExecuted>execution.maxSteps)throw new Error('computer task hierarchy execution budget exhausted');
    const delta=result.stepsExecuted-execution.stepsExecuted;
    if(this.totalStepsExecuted+delta>this.limits.maxTotalSteps)throw new Error('computer task hierarchy global step budget exhausted');
    this.totalStepsExecuted+=delta;
    execution.stepsExecuted=result.stepsExecuted;
    execution.lastStatus=result.status;
    return freezeExecution(execution);
  }

  execution(executionIdValue:string):ComputerTaskHierarchyExecution|undefined{
    const value=this.executions.get(executionId(executionIdValue));
    return value?freezeExecution(value):undefined;
  }

  snapshot():ComputerTaskHierarchySnapshot{
    return Object.freeze({
      rootExecutionId:this.rootExecutionId,
      limits:this.limits,
      totalStepsExecuted:this.totalStepsExecuted,
      executions:Object.freeze([...this.executions.values()].map(freezeExecution)),
    });
  }
}
