import test from 'node:test';
import assert from 'node:assert/strict';
import type { WindowsUiaCachedObservation, WindowsUiaControlSnapshot, WindowsUiaWindowRef } from '../src/computer/windowsUiaContract.js';
import { compileWindowsUiaSemanticLocatorCorrection } from '../src/computer/windowsUiaSemanticCorrectionCompiler.js';
import { evaluateWindowsUiaSemanticRecipeOffline } from '../src/computer/windowsUiaSemanticOfflineEvaluation.js';
import type { WindowsUiaSemanticRecipeManifest } from '../src/computer/windowsUiaSemanticRecipeManifest.js';

const windowRef:WindowsUiaWindowRef=Object.freeze({
  hwnd:'0x740',desktopSessionId:'interactive:1',process:Object.freeze({processId:740,startIdentity:'real-app-replay'}),generation:1,
});
function control(runtimeId:number[],controlType:string,automationId:string,name:string):WindowsUiaControlSnapshot{
  return Object.freeze({
    ref:Object.freeze({window:windowRef,runtimeId:Object.freeze(runtimeId),controlType,automationId,generation:1}),
    name,patterns:Object.freeze(['invoke'] as const),
  });
}
function observation(child:WindowsUiaControlSnapshot):WindowsUiaCachedObservation{
  const root:WindowsUiaControlSnapshot=Object.freeze({
    ref:Object.freeze({window:windowRef,runtimeId:Object.freeze([1]),controlType:'Window',generation:1}),
    patterns:Object.freeze(['window'] as const),children:Object.freeze([child]),
  });
  return Object.freeze({
    window:windowRef,root,itemCount:2,textBytes:new TextEncoder().encode(child.name??'').byteLength,
    truncated:false,invalidationEpoch:1,capturedAtMs:1,
  });
}

/**
 * Derived replay from exact observed provider identities, not a new empirical run:
 * Explorer exposed AddButton; Windows Terminal exposed NewTabButton.
 */
test('real-app locator correction preserves Explorer and recovers held-out Windows Terminal',()=>{
  const base:WindowsUiaSemanticRecipeManifest=Object.freeze({
    schemaVersion:1,revision:1,evidenceIds:Object.freeze(['xrc_mtbi8lrl_e5d9b80204456db1d1ba8908']),
    recipe:Object.freeze({
      id:'new-tab-skill',
      locator:Object.freeze({
        id:'new-tab-target',automationIds:Object.freeze(['AddButton']),
        names:Object.freeze(['Add New Tab']),controlTypes:Object.freeze(['Button','SplitButton']),
        requiredPatterns:Object.freeze(['invoke'] as const),requireEnabled:true,
      }),
      action:Object.freeze({kind:'invoke' as const}),
    }),
  });
  const compiled=compileWindowsUiaSemanticLocatorCorrection(base,{
    correctionId:'terminal-new-tab-id',evidenceIds:['xrc_mtbiu7gu_962beef7a68663d3a7ce55df'],addAutomationIds:['NewTabButton'],
  });
  assert.equal(compiled.status,'compiled');
  if(compiled.status!=='compiled')return;

  const result=evaluateWindowsUiaSemanticRecipeOffline(base,compiled.proposedManifest,[
    {
      caseId:'explorer-development',partition:'development',applicationId:'windows-file-explorer',providerFamily:'win32-explorer-uia',
      observation:observation(control([2],'Button','AddButton','Add New Tab')),
    },
    {
      caseId:'terminal-holdout',partition:'holdout',applicationId:'windows-terminal',providerFamily:'cascadia-uia',
      observation:observation(control([3],'SplitButton','NewTabButton','New Tab')),
    },
  ]);

  assert.equal(result.status,'improved');
  assert.equal(result.recoveries,1);
  assert.equal(result.regressions,0);
  assert.equal(result.caseResults.find((entry)=>entry.caseId==='explorer-development')?.proposedStatus,'ready');
  assert.equal(result.caseResults.find((entry)=>entry.caseId==='terminal-holdout')?.baseStatus,'grounding-missing');
  assert.equal(result.caseResults.find((entry)=>entry.caseId==='terminal-holdout')?.proposedStatus,'ready');
  assert.deepEqual(result.generalization.partitions,[
    {partition:'development',cases:1,recoveries:0,regressions:0,stableReady:1,proposedUnresolved:0,distinctApplications:1,distinctProviderFamilies:1},
    {partition:'holdout',cases:1,recoveries:1,regressions:0,stableReady:0,proposedUnresolved:0,distinctApplications:1,distinctProviderFamilies:1},
  ]);
  assert.equal(compiled.promotionApproved,false);
  assert.equal(compiled.authorityGranted,false);
  assert.equal(result.promotionEligible,false);
  assert.equal(result.authorityGranted,false);
});
