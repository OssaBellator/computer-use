import test from 'node:test';
import assert from 'node:assert/strict';
import { DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES } from '../src/computer/dp11WindowsEmpiricalEvaluation.js';
import { assessWindowsUiaSemanticBoundCorrectionReview } from '../src/computer/windowsUiaSemanticBoundCorrectionReview.js';
import { compileWindowsUiaSemanticLocatorCorrection } from '../src/computer/windowsUiaSemanticCorrectionCompiler.js';
import { digestWindowsUiaSemanticRecipeManifest, type WindowsUiaSemanticRecipeManifest } from '../src/computer/windowsUiaSemanticRecipeManifest.js';
import type { WindowsUiaSemanticCorrectionEpisode } from '../src/computer/windowsUiaSemanticCorrectionEpisode.js';

const EXPLORER='xrc_mtbi8lrl_e5d9b80204456db1d1ba8908';
const TERMINAL='xrc_mtbiu7gu_962beef7a68663d3a7ce55df';

function base():WindowsUiaSemanticRecipeManifest{
  return Object.freeze({
    schemaVersion:1,revision:1,evidenceIds:Object.freeze([EXPLORER]),
    recipe:Object.freeze({
      id:'new-tab-skill',locator:Object.freeze({
        id:'new-tab-target',automationIds:Object.freeze(['AddButton']),names:Object.freeze(['Add New Tab']),
        controlTypes:Object.freeze(['Button','SplitButton']),requiredPatterns:Object.freeze(['invoke'] as const),requireEnabled:true,
      }),action:Object.freeze({kind:'invoke' as const}),
    }),
  });
}
function compiled(baseManifest:WindowsUiaSemanticRecipeManifest,evidenceId:string){
  return compileWindowsUiaSemanticLocatorCorrection(baseManifest,{
    correctionId:'terminal-new-tab-id',evidenceIds:[evidenceId],addAutomationIds:['NewTabButton'],
  });
}
function episode(baseManifest:WindowsUiaSemanticRecipeManifest,proposedManifest:WindowsUiaSemanticRecipeManifest,evidenceId:string):WindowsUiaSemanticCorrectionEpisode{
  return Object.freeze({
    episodeId:'terminal-new-tab-correction',recipeId:'new-tab-skill',baseManifestDigest:digestWindowsUiaSemanticRecipeManifest(baseManifest),
    trigger:'grounding-missing',evidenceIds:Object.freeze([evidenceId]),proposedManifest,
  });
}

test('bound correction review requires both exact revision lineage and empirical Terminal provenance',()=>{
  const previous=base();
  const proposal=compiled(previous,TERMINAL);
  assert.equal(proposal.status,'compiled');
  if(proposal.status!=='compiled')return;
  const result=assessWindowsUiaSemanticBoundCorrectionReview(
    DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES,previous,episode(previous,proposal.proposedManifest,TERMINAL),
  );
  assert.equal(result.status,'reviewable');
  if(result.status==='reviewable'){
    assert.equal(result.evidenceBindings.length,2);
    assert.ok(result.evidenceBindings.every((entry)=>entry.evidenceId===TERMINAL&&entry.applicationId==='windows-terminal'));
    assert.equal(result.proposedManifestDigest,proposal.proposedManifestDigest);
  }
  assert.equal(result.promotionApproved,false);
  assert.equal(result.authorityGranted,false);
});

test('token-shaped but invented correction evidence cannot reach reviewable',()=>{
  const previous=base();
  const invented='xrc_invented_bound_review';
  const proposal=compiled(previous,invented);
  assert.equal(proposal.status,'compiled');
  if(proposal.status!=='compiled')return;
  const result=assessWindowsUiaSemanticBoundCorrectionReview(
    DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES,previous,episode(previous,proposal.proposedManifest,invented),
  );
  assert.equal(result.status,'rejected');
  if(result.status==='rejected')assert.equal(result.reason,`evidence:evidence-source-missing:${invented}`);
  assert.equal(result.promotionApproved,false);
  assert.equal(result.authorityGranted,false);
});

test('broken correction lineage is rejected before provenance can make it look reviewable',()=>{
  const previous=base();
  const proposal=compiled(previous,TERMINAL);
  assert.equal(proposal.status,'compiled');
  if(proposal.status!=='compiled')return;
  const bad=Object.freeze({...proposal.proposedManifest,parentDigest:`sha256:${'0'.repeat(64)}`});
  const result=assessWindowsUiaSemanticBoundCorrectionReview(
    DP11_WINDOWS_EMPIRICAL_EXPANDED_CASES,previous,episode(previous,bad,TERMINAL),
  );
  assert.equal(result.status,'rejected');
  if(result.status==='rejected')assert.equal(result.reason,'episode:revision-invalid');
  assert.deepEqual(result.evidenceBindings,[]);
});
