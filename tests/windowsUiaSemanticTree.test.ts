import test from 'node:test';
import assert from 'node:assert/strict';
import { captureWindowsUiaCachedObservation, type WindowsUiaWindowRef } from '../src/computer/windowsUiaContract.js';

const windowRef:WindowsUiaWindowRef=Object.freeze({
  hwnd:'0x600',desktopSessionId:'interactive:1',process:Object.freeze({processId:600,startIdentity:'p600'}),generation:2,
});
function ref(runtimeId:number[],controlType:string,generation:number){
  return {window:windowRef,runtimeId,controlType,generation};
}

test('cached observation preserves bounded recursive Control View tree with exact metrics', () => {
  const value={
    window:windowRef,itemCount:3,textBytes:11,truncated:false,invalidationEpoch:4,capturedAtMs:10,
    root:{
      ref:ref([1],'Window',1),name:'Root',patterns:['window'],children:[
        {ref:ref([1,1],'Button',1),name:'Save',patterns:['invoke']},
        {ref:ref([1,2],'Edit',1),name:'To',value:'abc',patterns:['value']},
      ],
    },
  };
  const captured=captureWindowsUiaCachedObservation(value,windowRef,{maxItems:10,maxTextBytes:100,maxDepth:3});
  assert.ok(captured);
  assert.equal(captured?.root?.children?.length,2);
  assert.equal(captured?.root?.children?.[1]?.value,'abc');
  assert.equal(captured?.itemCount,3);
  assert.equal(captured?.textBytes,11);
});

test('tree metrics cannot under-report or over-report represented content', () => {
  const root={ref:ref([1],'Window',1),name:'Root',patterns:['window']};
  assert.equal(captureWindowsUiaCachedObservation({
    window:windowRef,root,itemCount:2,textBytes:4,truncated:true,invalidationEpoch:1,capturedAtMs:1,
  },windowRef,{maxItems:10,maxTextBytes:100,maxDepth:2}),undefined);
  assert.equal(captureWindowsUiaCachedObservation({
    window:windowRef,root,itemCount:1,textBytes:3,truncated:true,invalidationEpoch:1,capturedAtMs:1,
  },windowRef,{maxItems:10,maxTextBytes:100,maxDepth:2}),undefined);
});

test('child from another window generation is rejected', () => {
  const other={...windowRef,generation:3};
  const value={
    window:windowRef,itemCount:2,textBytes:4,truncated:false,invalidationEpoch:1,capturedAtMs:1,
    root:{ref:ref([1],'Window',1),name:'Root',patterns:['window'],children:[
      {ref:{window:other,runtimeId:[2],controlType:'Button',generation:1},patterns:['invoke']},
    ]},
  };
  assert.equal(captureWindowsUiaCachedObservation(value,windowRef,{maxItems:10,maxTextBytes:100,maxDepth:2}),undefined);
});

test('depth and item budgets reject a provider tree that exceeded acquisition limits', () => {
  const deep={ref:ref([3],'Text',1),patterns:[]};
  const child={ref:ref([2],'Pane',1),patterns:[],children:[deep]};
  const root={ref:ref([1],'Window',1),patterns:['window'],children:[child]};
  const value={window:windowRef,root,itemCount:3,textBytes:0,truncated:false,invalidationEpoch:1,capturedAtMs:1};
  assert.equal(captureWindowsUiaCachedObservation(value,windowRef,{maxItems:3,maxTextBytes:100,maxDepth:1}),undefined);
  assert.equal(captureWindowsUiaCachedObservation(value,windowRef,{maxItems:2,maxTextBytes:100,maxDepth:3}),undefined);
});

test('cyclic semantic tree is rejected without recursive runaway', () => {
  const root:{ref:ReturnType<typeof ref>;patterns:string[];children?:unknown[]}={ref:ref([1],'Window',1),patterns:['window']};
  root.children=[root];
  const value={window:windowRef,root,itemCount:2,textBytes:0,truncated:false,invalidationEpoch:1,capturedAtMs:1};
  assert.equal(captureWindowsUiaCachedObservation(value,windowRef,{maxItems:10,maxTextBytes:100,maxDepth:5}),undefined);
});
