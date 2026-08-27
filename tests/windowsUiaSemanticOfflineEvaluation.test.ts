import test from 'node:test';
import assert from 'node:assert/strict';
import type { WindowsUiaCachedObservation, WindowsUiaControlSnapshot, WindowsUiaWindowRef } from '../src/computer/windowsUiaContract.js';
import { evaluateWindowsUiaSemanticRecipeOffline, type WindowsUiaSemanticOfflineReplayCase } from '../src/computer/windowsUiaSemanticOfflineEvaluation.js';
import { digestWindowsUiaSemanticRecipeManifest, type WindowsUiaSemanticRecipeManifest } from '../src/computer/windowsUiaSemanticRecipeManifest.js';
import { digestWindowsUiaSemanticReplayCorpus } from '../src/computer/windowsUiaSemanticReplayCorpus.js';

const windowRef:WindowsUiaWindowRef=Object.freeze({
  hwnd:'0x720',desktopSessionId:'interactive:1',process:Object.freeze({processId:720,startIdentity:'p720'}),generation:2,
});
function node(runtimeId:number[],controlType:string,input:Partial<WindowsUiaControlSnapshot>={}):WindowsUiaControlSnapshot{
  return Object.freeze({
    ref:Object.freeze({window:windowRef,runtimeId:Object.freeze(runtimeId),controlType,generation:1,...(input.ref?.automationId?{automationId:input.ref.automationId}:{})}),
    patterns:Object.freeze(input.patterns??[]),
    ...(input.name!==undefined?{name:input.name}:{}),
    ...(input.children!==undefined?{children:Object.freeze([...input.children])}:{}),
  });
}
function observation(children:readonly WindowsUiaControlSnapshot[]):WindowsUiaCachedObservation{
  const count=(entries:readonly WindowsUiaControlSnapshot[]):number=>entries.reduce((sum,entry)=>sum+1+count(entry.children??[]),0);
  const textBytes=(entries:readonly WindowsUiaControlSnapshot[]):number=>entries.reduce((sum,entry)=>sum+(entry.name===undefined?0:new TextEncoder().encode(entry.name).byteLength)+(entry.value===undefined?0:new TextEncoder().encode(entry.value).byteLength)+textBytes(entry.children??[]),0);
  return Object.freeze({window:windowRef,root:node([1],'Window',{patterns:['window'],children}),itemCount:count(children)+1,textBytes:textBytes(children),truncated:false,invalidationEpoch:1,capturedAtMs:1});
}
function manifests(baseNames:readonly string[],proposedNames:readonly string[]):readonly [WindowsUiaSemanticRecipeManifest,WindowsUiaSemanticRecipeManifest]{
  const base:WindowsUiaSemanticRecipeManifest=Object.freeze({
    schemaVersion:1,revision:1,evidenceIds:Object.freeze(['offline-base']),recipe:Object.freeze({
      id:'save-skill',locator:Object.freeze({id:'save-target',names:Object.freeze(baseNames),controlTypes:Object.freeze(['Button']),requiredPatterns:Object.freeze(['invoke'] as const)}),action:Object.freeze({kind:'invoke' as const}),
    }),
  });
  const proposed:WindowsUiaSemanticRecipeManifest=Object.freeze({
    schemaVersion:1,revision:2,parentDigest:digestWindowsUiaSemanticRecipeManifest(base),evidenceIds:Object.freeze(['offline-base','offline-proposal']),recipe:Object.freeze({
      id:'save-skill',locator:Object.freeze({id:'save-target',names:Object.freeze(proposedNames),controlTypes:Object.freeze(['Button']),requiredPatterns:Object.freeze(['invoke'] as const)}),action:Object.freeze({kind:'invoke' as const}),
    }),
  });
  return Object.freeze([base,proposed]);
}

test('offline semantic replay reports recovery without granting promotion or authority',()=>{
  const [base,proposed]=manifests(['Save'],['Save','Store']);
  const result=evaluateWindowsUiaSemanticRecipeOffline(base,proposed,[
    {caseId:'existing-save',observation:observation([node([2],'Button',{name:'Save',patterns:['invoke']})])},
    {caseId:'new-store',observation:observation([node([3],'Button',{name:'Store',patterns:['invoke']})])},
  ]);
  assert.equal(result.status,'improved');
  assert.match(result.corpusDigest,/^sha256:[a-f0-9]{64}$/);
  assert.equal(result.recoveries,1);
  assert.equal(result.regressions,0);
  assert.equal(result.stableReady,1);
  assert.equal(result.promotionEligible,false);
  assert.equal(result.authorityGranted,false);
});

test('offline semantic replay detects regression when proposed recipe loses a previously ready case',()=>{
  const [base,proposed]=manifests(['Save','Store'],['Store']);
  const result=evaluateWindowsUiaSemanticRecipeOffline(base,proposed,[
    {caseId:'save-case',observation:observation([node([2],'Button',{name:'Save',patterns:['invoke']})])},
  ]);
  assert.equal(result.status,'regressed');
  assert.equal(result.regressions,1);
  assert.equal(result.proposedUnresolved,1);
});

test('offline semantic replay can be non-regressing without claiming improvement',()=>{
  const [base,proposed]=manifests(['Save'],['Save']);
  const result=evaluateWindowsUiaSemanticRecipeOffline(base,proposed,[
    {caseId:'save-case',observation:observation([node([2],'Button',{name:'Save',patterns:['invoke']})])},
  ]);
  assert.equal(result.status,'non-regressing');
  assert.equal(result.stableReady,1);
  assert.equal(result.recoveries,0);
});

test('offline semantic replay retains ambiguity as unresolved rather than treating it as success',()=>{
  const [base,proposed]=manifests(['Save'],['Save','Store']);
  const result=evaluateWindowsUiaSemanticRecipeOffline(base,proposed,[
    {caseId:'ambiguous-store',observation:observation([
      node([2],'Button',{name:'Store',patterns:['invoke']}),node([3],'Button',{name:'STORE',patterns:['invoke']}),
    ])},
  ]);
  assert.equal(result.caseResults[0]?.proposedStatus,'grounding-ambiguous');
  assert.equal(result.proposedUnresolved,1);
  assert.equal(result.promotionEligible,false);
});

test('offline semantic replay measures application/provider breadth and retains per-domain regressions',()=>{
  const [base,proposed]=manifests(['Save','Store'],['Store']);
  const result=evaluateWindowsUiaSemanticRecipeOffline(base,proposed,[
    {caseId:'notepad-save',applicationId:'windows-notepad',providerFamily:'win32-richedit',observation:observation([node([2],'Button',{name:'Save',patterns:['invoke']})])},
    {caseId:'calculator-store',applicationId:'windows-calculator',providerFamily:'application-frame-uia',observation:observation([node([3],'Button',{name:'Store',patterns:['invoke']})])},
  ]);
  assert.deepEqual(result.generalization,{distinctApplications:2,distinctProviderFamilies:2,domains:[
    {domainId:'windows-calculator:application-frame-uia',cases:1,recoveries:0,regressions:0,stableReady:1,proposedUnresolved:0},
    {domainId:'windows-notepad:win32-richedit',cases:1,recoveries:0,regressions:1,stableReady:0,proposedUnresolved:1},
  ],partitions:[{partition:'development',cases:2,recoveries:0,regressions:1,stableReady:1,proposedUnresolved:1,distinctApplications:2,distinctProviderFamilies:2}]});
  assert.equal(Object.prototype.hasOwnProperty.call(result.generalization,'eligible'),false);
  assert.equal(Object.prototype.hasOwnProperty.call(result.generalization,'threshold'),false);
});

test('offline semantic replay counts only explicit bounded generalization labels',()=>{
  const [base,proposed]=manifests(['Save'],['Save']);
  const result=evaluateWindowsUiaSemanticRecipeOffline(base,proposed,[
    {caseId:'unlabeled',observation:observation([node([2],'Button',{name:'Save',patterns:['invoke']})])},
  ]);
  assert.equal(result.generalization.distinctApplications,0);
  assert.equal(result.generalization.distinctProviderFamilies,0);
  assert.equal(result.generalization.domains[0]?.domainId,'unknown-app:unknown-provider');
  assert.deepEqual(result.generalization.partitions,[{partition:'development',cases:1,recoveries:0,regressions:0,stableReady:1,proposedUnresolved:0,distinctApplications:0,distinctProviderFamilies:0}]);
  assert.throws(()=>evaluateWindowsUiaSemanticRecipeOffline(base,proposed,[
    {caseId:'bad-app',applicationId:'bad app',observation:observation([])},
  ]),/application-id-invalid/);
  assert.throws(()=>evaluateWindowsUiaSemanticRecipeOffline(base,proposed,[
    {caseId:'bad-provider',providerFamily:'bad provider',observation:observation([])},
  ]),/provider-family-invalid/);
});

test('offline semantic replay separates development recovery from held-out regression',()=>{
  const [base,proposed]=manifests(['Save','Store'],['Store','Commit']);
  const result=evaluateWindowsUiaSemanticRecipeOffline(base,proposed,[
    {caseId:'development-commit',partition:'development',applicationId:'training-shell',providerFamily:'test-uia',observation:observation([node([2],'Button',{name:'Commit',patterns:['invoke']})])},
    {caseId:'holdout-save',partition:'holdout',applicationId:'windows-notepad',providerFamily:'win32-richedit',observation:observation([node([3],'Button',{name:'Save',patterns:['invoke']})])},
  ]);
  assert.equal(result.status,'regressed');
  assert.deepEqual(result.generalization.partitions,[
    {partition:'development',cases:1,recoveries:1,regressions:0,stableReady:0,proposedUnresolved:0,distinctApplications:1,distinctProviderFamilies:1},
    {partition:'holdout',cases:1,recoveries:0,regressions:1,stableReady:0,proposedUnresolved:1,distinctApplications:1,distinctProviderFamilies:1},
  ]);
  assert.equal(result.promotionEligible,false);
  assert.equal(result.authorityGranted,false);
});

test('offline replay evaluates the same captured metadata that defines corpus identity',()=>{
  const [base,proposed]=manifests(['Save'],['Save']);
  let applicationReads=0;
  const replayCase={caseId:'capture-once',observation:observation([node([2],'Button',{name:'Save',patterns:['invoke']})])} as WindowsUiaSemanticOfflineReplayCase;
  Object.defineProperty(replayCase,'applicationId',{enumerable:true,get(){applicationReads+=1;return applicationReads===1?'app-first':'app-second';}});
  const result=evaluateWindowsUiaSemanticRecipeOffline(base,proposed,[replayCase]);
  assert.equal(applicationReads,1);
  assert.equal(result.generalization.distinctApplications,1);
  assert.equal(result.generalization.domains[0]?.domainId,'app-first:unknown-provider');
  assert.equal(result.caseResults[0]?.proposedStatus,'ready');
});

test('offline replay corpus digest is order-independent but content-sensitive',()=>{
  const a={caseId:'a',partition:'development' as const,applicationId:'app-a',providerFamily:'provider-a',observation:observation([node([2],'Button',{name:'Save',patterns:['invoke']})]),inputs:{level:1}};
  const b={caseId:'b',partition:'holdout' as const,applicationId:'app-b',providerFamily:'provider-b',observation:observation([node([3],'Button',{name:'Store',patterns:['invoke']})]),inputs:{text:'x'}};
  const first=digestWindowsUiaSemanticReplayCorpus([a,b]);
  assert.equal(first,digestWindowsUiaSemanticReplayCorpus([b,a]));
  assert.notEqual(first,digestWindowsUiaSemanticReplayCorpus([a,{...b,partition:'development'}]));
  assert.notEqual(first,digestWindowsUiaSemanticReplayCorpus([a,{...b,inputs:{text:'y'}}]));
});

test('offline semantic replay requires exact revision lineage and bounded unique case identities',()=>{
  const [base,proposed]=manifests(['Save'],['Save','Store']);
  const bad=Object.freeze({...proposed,parentDigest:`sha256:${'0'.repeat(64)}`});
  assert.throws(()=>evaluateWindowsUiaSemanticRecipeOffline(base,bad,[{caseId:'one',observation:observation([])}]),/parent-mismatch/);
  assert.throws(()=>evaluateWindowsUiaSemanticRecipeOffline(base,proposed,[]),/cases-invalid/);
  assert.throws(()=>evaluateWindowsUiaSemanticRecipeOffline(base,proposed,[
    {caseId:'duplicate',observation:observation([])},{caseId:'duplicate',observation:observation([])},
  ]),/case-id-invalid/);
});
