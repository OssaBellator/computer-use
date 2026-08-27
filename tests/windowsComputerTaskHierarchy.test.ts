import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { ComputerTaskHierarchyLedger } from '../src/computer/computerTaskHierarchy.js';
import {
  createComputerTaskHierarchyCheckpoint,
  decodeComputerTaskHierarchyCheckpoint,
  encodeComputerTaskHierarchyCheckpoint,
  InMemoryComputerTaskHierarchyCheckpointStore,
  loadComputerTaskHierarchyCheckpointStoreHead,
  restoreComputerTaskHierarchyLedger,
  validateComputerTaskHierarchyCheckpoint,
} from '../src/computer/computerTaskHierarchyCheckpoint.js';

const ROOT='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const CHILD='bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const GRANDCHILD='cccccccccccccccccccccccccccccccc';
const OTHER='dddddddddddddddddddddddddddddddd';

function program(id:string):ComputerTaskProgram{
  return {
    id,
    entry:'read',
    steps:[{kind:'observe',id:'read',request:{adapterId:'fake',channel:'semantic-ui'}}],
  };
}

function ledger(){
  return new ComputerTaskHierarchyLedger({
    executionId:ROOT,
    program:program('root-program'),
    maxSteps:20,
    authorityGrantRefs:['grant:root-only'],
  },{maxDepth:3,maxExecutions:4,maxTotalSteps:30});
}

test('delegation never implicitly inherits parent authority refs',()=>{
  const hierarchy=ledger();
  const child=hierarchy.delegate({
    parentExecutionId:ROOT,
    childExecutionId:CHILD,
    program:program('child-program'),
    maxSteps:10,
  });
  assert.deepEqual(hierarchy.execution(ROOT)?.authorityGrantRefs,['grant:root-only']);
  assert.deepEqual(child.authorityGrantRefs,[]);
});

test('child authority refs are explicit bounded opaque references',()=>{
  const hierarchy=ledger();
  const child=hierarchy.delegate({
    parentExecutionId:ROOT,
    childExecutionId:CHILD,
    program:program('child-program'),
    maxSteps:10,
    authorityGrantRefs:['grant:child:a','grant:child:b'],
  });
  assert.deepEqual(child.authorityGrantRefs,['grant:child:a','grant:child:b']);
  assert.equal(Object.isFrozen(child.authorityGrantRefs),true);
  assert.throws(()=>hierarchy.delegate({
    parentExecutionId:ROOT,
    childExecutionId:OTHER,
    program:program('other-program'),
    maxSteps:2,
    authorityGrantRefs:['bad ref with spaces'],
  }),/authority ref invalid/);
});

test('hierarchy counts cumulative runtime progress once across child resumes',()=>{
  const hierarchy=ledger();
  hierarchy.delegate({parentExecutionId:ROOT,childExecutionId:CHILD,program:program('child-program'),maxSteps:10});
  hierarchy.recordRuntimeProgress(CHILD,{stepsExecuted:3,status:'suspended'});
  assert.equal(hierarchy.snapshot().totalStepsExecuted,3);
  hierarchy.recordRuntimeProgress(CHILD,{stepsExecuted:3,status:'suspended'});
  assert.equal(hierarchy.snapshot().totalStepsExecuted,3);
  hierarchy.recordRuntimeProgress(CHILD,{stepsExecuted:5,status:'completed'});
  assert.equal(hierarchy.snapshot().totalStepsExecuted,5);
  assert.throws(()=>hierarchy.recordRuntimeProgress(CHILD,{stepsExecuted:4,status:'completed'}),/progress rolled back/);
});

test('per-execution and global budgets cannot be reset by creating children',()=>{
  const hierarchy=new ComputerTaskHierarchyLedger({executionId:ROOT,program:program('root'),maxSteps:5},{
    maxDepth:3,maxExecutions:4,maxTotalSteps:6,
  });
  hierarchy.delegate({parentExecutionId:ROOT,childExecutionId:CHILD,program:program('child'),maxSteps:6});
  hierarchy.recordRuntimeProgress(CHILD,{stepsExecuted:5,status:'suspended'});
  assert.throws(()=>hierarchy.recordRuntimeProgress(CHILD,{stepsExecuted:7,status:'completed'}),/execution budget exhausted/);
  hierarchy.delegate({parentExecutionId:ROOT,childExecutionId:OTHER,program:program('other'),maxSteps:1});
  assert.throws(()=>hierarchy.recordRuntimeProgress(OTHER,{stepsExecuted:2,status:'completed'}),/execution budget exhausted/);
  hierarchy.recordRuntimeProgress(OTHER,{stepsExecuted:1,status:'completed'});
  assert.equal(hierarchy.snapshot().totalStepsExecuted,6);
});

test('delegation depth and execution count are bounded',()=>{
  const hierarchy=new ComputerTaskHierarchyLedger({executionId:ROOT,program:program('root'),maxSteps:10},{
    maxDepth:1,maxExecutions:2,maxTotalSteps:20,
  });
  hierarchy.delegate({parentExecutionId:ROOT,childExecutionId:CHILD,program:program('child'),maxSteps:5});
  assert.throws(()=>hierarchy.delegate({parentExecutionId:CHILD,childExecutionId:GRANDCHILD,program:program('grandchild'),maxSteps:2}),/depth exhausted/);
  assert.throws(()=>hierarchy.delegate({parentExecutionId:ROOT,childExecutionId:OTHER,program:program('other'),maxSteps:2}),/execution count exhausted/);
});

test('terminal or unresolved parent cannot manufacture new delegated work',()=>{
  for(const status of ['completed','failed','unknown-dispatch','reconciliation-required'] as const){
    const hierarchy=ledger();
    hierarchy.recordRuntimeProgress(ROOT,{stepsExecuted:1,status});
    assert.throws(()=>hierarchy.delegate({
      parentExecutionId:ROOT,
      childExecutionId:CHILD,
      program:program('child'),
      maxSteps:3,
    }),/parent cannot delegate/);
  }
  const suspended=ledger();
  suspended.recordRuntimeProgress(ROOT,{stepsExecuted:1,status:'suspended'});
  assert.equal(suspended.delegate({parentExecutionId:ROOT,childExecutionId:CHILD,program:program('child'),maxSteps:3}).parentExecutionId,ROOT);
});

test('hierarchy snapshots retain program identity without executable task payloads',()=>{
  const hierarchy=ledger();
  const child=hierarchy.delegate({parentExecutionId:ROOT,childExecutionId:CHILD,program:program('child'),maxSteps:4});
  const snapshot=hierarchy.snapshot();
  assert.match(child.programHash,/^[0-9a-f]{64}$/);
  assert.equal('program' in (snapshot.executions[1] as unknown as Record<string,unknown>),false);
  assert.equal(snapshot.executions[1]?.programId,'child');
});

test('hierarchy checkpoint round-trip is integrity checked and deeply bounded',()=>{
  const hierarchy=ledger();
  hierarchy.delegate({parentExecutionId:ROOT,childExecutionId:CHILD,program:program('child'),maxSteps:6,authorityGrantRefs:['grant:child']});
  hierarchy.recordRuntimeProgress(ROOT,{stepsExecuted:2,status:'suspended'});
  hierarchy.recordRuntimeProgress(CHILD,{stepsExecuted:3,status:'suspended'});
  const checkpoint=createComputerTaskHierarchyCheckpoint(hierarchy.snapshot());
  const decoded=decodeComputerTaskHierarchyCheckpoint(encodeComputerTaskHierarchyCheckpoint(checkpoint));
  assert.deepEqual(decoded,checkpoint);
  assert.equal(Object.isFrozen(decoded),true);
  assert.equal(Object.isFrozen(decoded.executions),true);
  assert.equal(decoded.totalStepsExecuted,5);
});

test('hierarchy checkpoint integrity rejects payload tampering',()=>{
  const checkpoint=createComputerTaskHierarchyCheckpoint(ledger().snapshot());
  const encoded=encodeComputerTaskHierarchyCheckpoint(checkpoint);
  const parsed=JSON.parse(encoded) as {payload:{totalStepsExecuted:number}};
  parsed.payload.totalStepsExecuted=1;
  assert.throws(()=>decodeComputerTaskHierarchyCheckpoint(JSON.stringify(parsed)),/(integrity mismatch|total steps inconsistent)/);
});

test('hierarchy checkpoint rejects impossible topology and inconsistent totals',()=>{
  const hierarchy=ledger();
  hierarchy.delegate({parentExecutionId:ROOT,childExecutionId:CHILD,program:program('child'),maxSteps:4});
  const checkpoint=createComputerTaskHierarchyCheckpoint(hierarchy.snapshot());
  const badTopology=structuredClone(checkpoint) as unknown as Record<string,unknown>;
  const executions=badTopology.executions as Array<Record<string,unknown>>;
  executions[1]!.depth=3;
  assert.throws(()=>validateComputerTaskHierarchyCheckpoint(badTopology),/topology invalid/);
  const badTotal=structuredClone(checkpoint) as unknown as Record<string,unknown>;
  badTotal.totalStepsExecuted=1;
  assert.throws(()=>validateComputerTaskHierarchyCheckpoint(badTotal),/total steps inconsistent/);
});

test('hierarchy restore requires exact executable programs for every durable program hash',()=>{
  const hierarchy=ledger();
  hierarchy.delegate({parentExecutionId:ROOT,childExecutionId:CHILD,program:program('child'),maxSteps:6});
  hierarchy.recordRuntimeProgress(CHILD,{stepsExecuted:2,status:'suspended'});
  const checkpoint=createComputerTaskHierarchyCheckpoint(hierarchy.snapshot());
  const restored=restoreComputerTaskHierarchyLedger(checkpoint,new Map([
    [ROOT,program('root-program')],
    [CHILD,program('child')],
  ]));
  assert.deepEqual(restored.snapshot(),hierarchy.snapshot());
  assert.throws(()=>restoreComputerTaskHierarchyLedger(checkpoint,new Map([
    [ROOT,program('root-program')],
    [CHILD,program('changed-child')],
  ])),/program mismatch/);
  assert.throws(()=>restoreComputerTaskHierarchyLedger(checkpoint,new Map([[ROOT,program('root-program')]])),/child program missing/);
});

test('hierarchy checkpoint store CAS prevents stale parent snapshots from overwriting newer lineage',async()=>{
  const store=new InMemoryComputerTaskHierarchyCheckpointStore();
  const first=createComputerTaskHierarchyCheckpoint(ledger().snapshot());
  assert.deepEqual(await store.compareAndSwap(ROOT,0,first),{status:'committed',revision:1});
  const hierarchy=ledger();
  hierarchy.delegate({parentExecutionId:ROOT,childExecutionId:CHILD,program:program('child'),maxSteps:4});
  const second=createComputerTaskHierarchyCheckpoint(hierarchy.snapshot());
  assert.deepEqual(await store.compareAndSwap(ROOT,1,second),{status:'committed',revision:2});
  assert.deepEqual(await store.compareAndSwap(ROOT,1,first),{status:'conflict',currentRevision:2});
  const head=await loadComputerTaskHierarchyCheckpointStoreHead(store,ROOT);
  assert.equal(head?.revision,2);
  assert.equal(head?.checkpoint.executions.length,2);
});
