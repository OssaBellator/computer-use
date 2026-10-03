import test from 'node:test';
import assert from 'node:assert/strict';
import { compileWindowsUiaSemanticLocatorCorrection } from '../src/computer/windowsUiaSemanticCorrectionCompiler.js';
import { digestWindowsUiaSemanticRecipeManifest, validateWindowsUiaSemanticRecipeRevision, type WindowsUiaSemanticRecipeManifest } from '../src/computer/windowsUiaSemanticRecipeManifest.js';

function baseManifest(names:readonly string[]=['Save'],automationIds?:readonly string[]):WindowsUiaSemanticRecipeManifest {
  return Object.freeze({
    schemaVersion:1,revision:1,evidenceIds:Object.freeze(['base-evidence']),
    recipe:Object.freeze({
      id:'save-skill',
      locator:Object.freeze({
        id:'save-target',
        ...(automationIds?{automationIds:Object.freeze([...automationIds])}:{}),
        names:Object.freeze([...names]),controlTypes:Object.freeze(['Button']),requiredPatterns:Object.freeze(['invoke'] as const),requireEnabled:true,
      }),
      action:Object.freeze({kind:'invoke' as const}),
    }),
  });
}

test('offline correction compiler adds exact semantic alternatives as one valid child revision',()=>{
  const base=baseManifest();
  const result=compileWindowsUiaSemanticLocatorCorrection(base,{correctionId:'corr-store-name',evidenceIds:['store-observation'],addNames:['Store']});
  assert.equal(result.status,'compiled');
  if(result.status==='compiled'){
    assert.equal(result.proposedManifest.revision,2);
    assert.equal(result.proposedManifest.parentDigest,digestWindowsUiaSemanticRecipeManifest(base));
    assert.deepEqual(result.proposedManifest.recipe.locator.names,['Save','Store']);
    assert.deepEqual(result.proposedManifest.evidenceIds,['base-evidence','store-observation']);
    assert.doesNotThrow(()=>validateWindowsUiaSemanticRecipeRevision(base,result.proposedManifest));
    assert.equal(result.authorityGranted,false);
    assert.equal(result.promotionApproved,false);
  }
});

test('offline correction compiler preserves semantic action and target constraints',()=>{
  const base=baseManifest(['Save'],['saveButton']);
  const result=compileWindowsUiaSemanticLocatorCorrection(base,{correctionId:'corr-alt-id',evidenceIds:['alt-id-observation'],addAutomationIds:['commitButton'],addNames:['Commit']});
  assert.equal(result.status,'compiled');
  if(result.status==='compiled'){
    assert.deepEqual(result.proposedManifest.recipe.action,base.recipe.action);
    assert.deepEqual(result.proposedManifest.recipe.locator.controlTypes,base.recipe.locator.controlTypes);
    assert.deepEqual(result.proposedManifest.recipe.locator.requiredPatterns,base.recipe.locator.requiredPatterns);
    assert.equal(result.proposedManifest.recipe.locator.requireEnabled,true);
    assert.deepEqual(result.proposedManifest.recipe.locator.automationIds,['saveButton','commitButton']);
    assert.deepEqual(result.proposedManifest.recipe.locator.names,['Save','Commit']);
    assert.equal('dispatch' in result,false);
    assert.equal('effect' in result,false);
    assert.equal('grants' in result,false);
  }
});

test('offline correction compiler rejects duplicate-only corrections instead of manufacturing a revision',()=>{
  const result=compileWindowsUiaSemanticLocatorCorrection(baseManifest(['Save'],['saveButton']),{
    correctionId:'corr-duplicate',evidenceIds:['duplicate-observation'],addAutomationIds:['saveButton'],addNames:['SAVE'],
  });
  assert.equal(result.status,'rejected');
  if(result.status==='rejected')assert.equal(result.reason,'no-change');
  assert.equal(result.authorityGranted,false);
  assert.equal(result.promotionApproved,false);
});

test('offline correction compiler fails closed when additive locator breadth would exceed bounds',()=>{
  const names=Array.from({length:16},(_,index)=>`Name${index}`);
  const result=compileWindowsUiaSemanticLocatorCorrection(baseManifest(names),{correctionId:'corr-overflow',evidenceIds:['overflow-observation'],addNames:['Seventeenth']});
  assert.equal(result.status,'rejected');
  if(result.status==='rejected')assert.equal(result.reason,'names-overflow');
});

test('offline correction compiler validates correction metadata and requires a real additive change',()=>{
  assert.equal(compileWindowsUiaSemanticLocatorCorrection(baseManifest(),{correctionId:'bad id',evidenceIds:['one'],addNames:['Store']}).status,'rejected');
  assert.equal(compileWindowsUiaSemanticLocatorCorrection(baseManifest(),{correctionId:'corr-empty',evidenceIds:[] as string[],addNames:['Store']}).status,'rejected');
  const none=compileWindowsUiaSemanticLocatorCorrection(baseManifest(),{correctionId:'corr-none',evidenceIds:['one']});
  assert.equal(none.status,'rejected');
  if(none.status==='rejected')assert.equal(none.reason,'no-change');
});
