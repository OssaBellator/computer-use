import test from 'node:test';
import assert from 'node:assert/strict';
import type { WindowsUiaCachedObservation, WindowsUiaControlSnapshot, WindowsUiaWindowRef } from '../src/computer/windowsUiaContract.js';
import { instantiateWindowsUiaSemanticRecipe } from '../src/computer/windowsUiaSemanticRecipe.js';

const windowRef:WindowsUiaWindowRef=Object.freeze({
  hwnd:'0x710',desktopSessionId:'interactive:1',process:Object.freeze({processId:710,startIdentity:'p710'}),generation:4,
});
function node(runtimeId:number[],controlType:string,input:Partial<WindowsUiaControlSnapshot>={}):WindowsUiaControlSnapshot{
  return Object.freeze({
    ref:Object.freeze({window:windowRef,runtimeId:Object.freeze(runtimeId),controlType,generation:1,...(input.ref?.automationId?{automationId:input.ref.automationId}:{})}),
    patterns:Object.freeze(input.patterns??[]),
    ...(input.name!==undefined?{name:input.name}:{}),
    ...(input.enabled!==undefined?{enabled:input.enabled}:{}),
    ...(input.children!==undefined?{children:Object.freeze([...input.children])}:{}),
  });
}
function observation(children:readonly WindowsUiaControlSnapshot[]):WindowsUiaCachedObservation{
  return Object.freeze({window:windowRef,root:node([1],'Window',{patterns:['window'],children}),itemCount:children.length+1,textBytes:0,truncated:false,invalidationEpoch:1,capturedAtMs:1});
}

test('portable semantic recipe instantiates an invoke action without carrying authority',()=>{
  const button=node([2],'Button',{name:'Run',patterns:['invoke'],ref:{window:windowRef,runtimeId:[2],controlType:'Button',generation:1,automationId:'runButton'}});
  const result=instantiateWindowsUiaSemanticRecipe(observation([button]),{
    id:'run-command',locator:{id:'run-target',automationIds:['runButton'],names:['Run'],controlTypes:['Button'],requiredPatterns:['invoke']},action:{kind:'invoke'},
  });
  assert.equal(result.status,'ready');
  if(result.status==='ready'){
    assert.deepEqual(result.action,{kind:'invoke'});
    assert.deepEqual(result.ref.runtimeId,[2]);
    assert.equal(Object.prototype.hasOwnProperty.call(result,'effect'),false);
    assert.equal(Object.prototype.hasOwnProperty.call(result,'grants'),false);
    assert.equal(Object.prototype.hasOwnProperty.call(result,'dispatch'),false);
  }
});

test('portable semantic recipe binds bounded runtime text inputs instead of embedding task-specific values',()=>{
  const edit=node([3],'Edit',{name:'Document',patterns:['value']});
  const result=instantiateWindowsUiaSemanticRecipe(observation([edit]),{
    id:'write-text',locator:{id:'document-target',names:['Document'],controlTypes:['Edit'],requiredPatterns:['value']},action:{kind:'set-value',inputKey:'text'},
  },{text:'hello portable skill'});
  assert.equal(result.status,'ready');
  if(result.status==='ready')assert.deepEqual(result.action,{kind:'set-value',value:'hello portable skill'});
});

test('portable semantic recipe propagates ambiguous grounding without producing an action',()=>{
  const a=node([4],'Button',{name:'Save',patterns:['invoke']});
  const b=node([5],'Button',{name:'SAVE',patterns:['invoke']});
  const result=instantiateWindowsUiaSemanticRecipe(observation([a,b]),{
    id:'save-command',locator:{id:'save-target',names:['Save'],controlTypes:['Button'],requiredPatterns:['invoke']},action:{kind:'invoke'},
  });
  assert.equal(result.status,'grounding-ambiguous');
  assert.equal(Object.prototype.hasOwnProperty.call(result,'action'),false);
  assert.ok(result.evidence.includes('windows-uia-semantic-recipe-no-dispatch'));
});

test('portable semantic recipe rejects missing or wrong-typed dynamic inputs before any action exists',()=>{
  const slider=node([6],'Slider',{name:'Volume',patterns:['range-value']});
  const recipe={id:'set-volume',locator:{id:'volume-target',names:['Volume'],controlTypes:['Slider'],requiredPatterns:['range-value'] as const},action:{kind:'set-range-value' as const,inputKey:'level'}};
  const missing=instantiateWindowsUiaSemanticRecipe(observation([slider]),recipe,{});
  assert.equal(missing.status,'input-invalid');
  const wrong=instantiateWindowsUiaSemanticRecipe(observation([slider]),recipe,{level:'high'});
  assert.equal(wrong.status,'input-invalid');
  const good=instantiateWindowsUiaSemanticRecipe(observation([slider]),recipe,{level:73});
  assert.equal(good.status,'ready');
  if(good.status==='ready')assert.deepEqual(good.action,{kind:'set-range-value',value:73});
});

test('portable semantic recipe validates bounded recipe identities and input keys',()=>{
  const tree=observation([]);
  assert.throws(()=>instantiateWindowsUiaSemanticRecipe(tree,{id:'bad id',locator:{id:'target',names:['Run'],controlTypes:['Button']},action:{kind:'invoke'}}),/windows-uia-semantic-recipe-invalid/);
  assert.throws(()=>instantiateWindowsUiaSemanticRecipe(tree,{id:'write',locator:{id:'target',names:['Document'],controlTypes:['Edit']},action:{kind:'set-value',inputKey:'bad key'}}),/windows-uia-semantic-recipe-input-key-invalid/);
});
