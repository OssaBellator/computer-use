import test from 'node:test';
import assert from 'node:assert/strict';
import type { ComputerTaskProgram } from '../src/computer/computerTask.js';
import { ComputerTaskHierarchyLedger } from '../src/computer/computerTaskHierarchy.js';

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
