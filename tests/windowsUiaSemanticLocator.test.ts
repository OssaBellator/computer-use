import test from 'node:test';
import assert from 'node:assert/strict';
import type { WindowsUiaCachedObservation, WindowsUiaControlSnapshot, WindowsUiaWindowRef } from '../src/computer/windowsUiaContract.js';
import { resolveWindowsUiaSemanticLocator } from '../src/computer/windowsUiaSemanticLocator.js';

const windowRef:WindowsUiaWindowRef=Object.freeze({
  hwnd:'0x700',desktopSessionId:'interactive:1',process:Object.freeze({processId:700,startIdentity:'p700'}),generation:3,
});
function node(runtimeId:number[],controlType:string,input:Partial<WindowsUiaControlSnapshot>={}):WindowsUiaControlSnapshot{
  return Object.freeze({
    ref:Object.freeze({window:windowRef,runtimeId:Object.freeze(runtimeId),controlType,generation:1,...(input.ref?.automationId?{automationId:input.ref.automationId}:{})}),
    patterns:Object.freeze(input.patterns??[]),
    ...(input.name!==undefined?{name:input.name}:{}),
    ...(input.enabled!==undefined?{enabled:input.enabled}:{}),
    ...(input.offscreen!==undefined?{offscreen:input.offscreen}:{}),
    ...(input.children!==undefined?{children:Object.freeze([...input.children])}:{}),
  });
}
function observation(children:readonly WindowsUiaControlSnapshot[]):WindowsUiaCachedObservation{
  return Object.freeze({
    window:windowRef,
    root:node([1],'Window',{patterns:['window'],children}),
    itemCount:children.length+1,textBytes:0,truncated:false,invalidationEpoch:1,capturedAtMs:1,
  });
}

test('semantic locator prefers exact automation id over semantic-name alternatives',()=>{
  const byName=node([2],'Button',{name:'Save',patterns:['invoke']});
  const byId=node([3],'Button',{name:'Store',patterns:['invoke'],ref:{window:windowRef,runtimeId:[3],controlType:'Button',generation:1,automationId:'saveButton'}});
  const result=resolveWindowsUiaSemanticLocator(observation([byName,byId]),{
    id:'save-action',automationIds:['saveButton'],names:['Save'],controlTypes:['Button'],requiredPatterns:['invoke'],
  });
  assert.equal(result.status,'matched');
  if(result.status==='matched'){
    assert.equal(result.basis,'automation-id');
    assert.deepEqual(result.ref.runtimeId,[3]);
  }
});

test('semantic locator falls back to exact semantic name when provider automation id changes',()=>{
  const plus=node([4],'Button',{name:'Plus',patterns:['invoke'],ref:{window:windowRef,runtimeId:[4],controlType:'Button',generation:1,automationId:'provider-v2-plus'}});
  const result=resolveWindowsUiaSemanticLocator(observation([plus]),{
    id:'calculator-plus',automationIds:['plusButton'],names:['Plus','+'],controlTypes:['Button'],requiredPatterns:['invoke'],
  });
  assert.equal(result.status,'matched');
  if(result.status==='matched'){
    assert.equal(result.basis,'semantic-name');
    assert.deepEqual(result.ref.runtimeId,[4]);
  }
});

test('semantic locator fails closed when the active identifier tier is ambiguous',()=>{
  const one=node([5],'Button',{name:'Save',patterns:['invoke']});
  const two=node([6],'Button',{name:'SAVE',patterns:['invoke']});
  const result=resolveWindowsUiaSemanticLocator(observation([one,two]),{
    id:'ambiguous-save',names:['Save'],controlTypes:['Button'],requiredPatterns:['invoke'],
  });
  assert.equal(result.status,'ambiguous');
  if(result.status==='ambiguous'){
    assert.equal(result.basis,'semantic-name');
    assert.equal(result.candidateCount,2);
  }
});

test('semantic locator filters disabled offscreen and pattern-incompatible controls before matching',()=>{
  const disabled=node([7],'Button',{name:'Run',enabled:false,patterns:['invoke']});
  const offscreen=node([8],'Button',{name:'Run',offscreen:true,patterns:['invoke']});
  const wrongPattern=node([9],'Button',{name:'Run',patterns:['toggle']});
  const result=resolveWindowsUiaSemanticLocator(observation([disabled,offscreen,wrongPattern]),{
    id:'run-action',names:['Run'],controlTypes:['Button'],requiredPatterns:['invoke'],
  });
  assert.equal(result.status,'missing');
});

test('semantic locator validation rejects unbounded or identity-free plans',()=>{
  const tree=observation([]);
  assert.throws(()=>resolveWindowsUiaSemanticLocator(tree,{id:'missing-identity',controlTypes:['Button']}),/windows-uia-semantic-locator-identity-missing/);
  assert.throws(()=>resolveWindowsUiaSemanticLocator(tree,{id:'bad id',names:['Save'],controlTypes:['Button']}),/windows-uia-semantic-locator-id-invalid/);
  assert.throws(()=>resolveWindowsUiaSemanticLocator(tree,{id:'duplicate-name',names:['Save','Save'],controlTypes:['Button']}),/windows-uia-semantic-locator-names-invalid/);
});
