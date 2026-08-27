import {
  validateComputerTaskCheckpoint,
  type ComputerTaskCheckpoint,
} from './computerTaskCheckpoint.js';

export const COMPUTER_TASK_CHECKPOINT_STORE_MAX_REVISION = 1_000_000_000;

export interface ComputerTaskCheckpointStoreEntry {
  readonly executionId:string;
  readonly revision:number;
  readonly checkpoint:ComputerTaskCheckpoint;
}

export type ComputerTaskCheckpointStoreCommitResult =
  | {readonly status:'committed';readonly revision:number}
  | {readonly status:'conflict';readonly currentRevision:number};

/**
 * Durable anti-rollback boundary for long-horizon task checkpoints.
 * Revision 0 means "no durable checkpoint exists yet". Every successful write
 * must atomically compare the expected revision and advance it by exactly one.
 */
export interface ComputerTaskCheckpointStore {
  read(executionId:string):Promise<ComputerTaskCheckpointStoreEntry|undefined>;
  compareAndSwap(
    executionId:string,
    expectedRevision:number,
    checkpoint:ComputerTaskCheckpoint,
  ):Promise<ComputerTaskCheckpointStoreCommitResult>;
}

function validExecutionId(value:string):boolean{return /^[0-9a-f]{32,64}$/.test(value);}
function validRevision(value:number,allowZero:boolean):boolean{
  return Number.isSafeInteger(value)&&value>=(allowZero?0:1)&&value<=COMPUTER_TASK_CHECKPOINT_STORE_MAX_REVISION;
}

function freezeEntry(entry:ComputerTaskCheckpointStoreEntry):ComputerTaskCheckpointStoreEntry{
  return Object.freeze({executionId:entry.executionId,revision:entry.revision,checkpoint:entry.checkpoint});
}

export function validateComputerTaskCheckpointStoreEntry(
  value:unknown,
  executionId?:string,
):asserts value is ComputerTaskCheckpointStoreEntry{
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('invalid computer task checkpoint store entry');
  const raw=value as Partial<ComputerTaskCheckpointStoreEntry>;
  if(typeof raw.executionId!=='string'||!validExecutionId(raw.executionId)||
     typeof raw.revision!=='number'||!validRevision(raw.revision,false)||raw.checkpoint===undefined){
    throw new Error('invalid computer task checkpoint store entry');
  }
  validateComputerTaskCheckpoint(raw.checkpoint);
  if(raw.checkpoint.execution.id!==raw.executionId)throw new Error('computer task checkpoint store execution mismatch');
  if(executionId!==undefined&&raw.executionId!==executionId)throw new Error('computer task checkpoint store execution mismatch');
}

/** Returns only a validated monotonic store head suitable for runtime resume. */
export async function loadComputerTaskCheckpointStoreHead(
  store:ComputerTaskCheckpointStore,
  executionId:string,
):Promise<ComputerTaskCheckpointStoreEntry|undefined>{
  if(!validExecutionId(executionId))throw new Error('computer task execution id is invalid');
  const value=await store.read(executionId);
  if(value===undefined)return undefined;
  validateComputerTaskCheckpointStoreEntry(value,executionId);
  return freezeEntry(value);
}

/**
 * Deterministic in-memory reference implementation used by tests and embedders.
 * Production stores must provide equivalent atomic CAS semantics durably.
 */
export class InMemoryComputerTaskCheckpointStore implements ComputerTaskCheckpointStore {
  private readonly entries=new Map<string,ComputerTaskCheckpointStoreEntry>();

  async read(executionId:string):Promise<ComputerTaskCheckpointStoreEntry|undefined>{
    if(!validExecutionId(executionId))throw new Error('computer task execution id is invalid');
    const entry=this.entries.get(executionId);
    return entry?freezeEntry(entry):undefined;
  }

  async compareAndSwap(
    executionId:string,
    expectedRevision:number,
    checkpoint:ComputerTaskCheckpoint,
  ):Promise<ComputerTaskCheckpointStoreCommitResult>{
    if(!validExecutionId(executionId)||!validRevision(expectedRevision,true))throw new Error('computer task checkpoint store request invalid');
    validateComputerTaskCheckpoint(checkpoint);
    if(checkpoint.execution.id!==executionId)throw new Error('computer task checkpoint store execution mismatch');
    const current=this.entries.get(executionId);
    const currentRevision=current?.revision??0;
    if(currentRevision!==expectedRevision)return Object.freeze({status:'conflict',currentRevision});
    if(currentRevision>=COMPUTER_TASK_CHECKPOINT_STORE_MAX_REVISION)throw new Error('computer task checkpoint store revision exhausted');
    const revision=currentRevision+1;
    this.entries.set(executionId,freezeEntry({executionId,revision,checkpoint}));
    return Object.freeze({status:'committed',revision});
  }
}
