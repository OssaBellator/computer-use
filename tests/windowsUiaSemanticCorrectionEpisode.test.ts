import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assessWindowsUiaSemanticCorrectionEpisode,
  type WindowsUiaSemanticCorrectionEpisode,
} from '../src/computer/windowsUiaSemanticCorrectionEpisode.js';
import {
  digestWindowsUiaSemanticRecipeManifest,
  type WindowsUiaSemanticRecipeManifest,
} from '../src/computer/windowsUiaSemanticRecipeManifest.js';

const baseRecipe=Object.freeze({
  id:'calculator-add',
  locator:Object.freeze({
    id:'calculator-seven',automationIds:Object.freeze(['num7Button']),names:Object.freeze(['Seven']),
    controlTypes:Object.freeze(['Button']),requiredPatterns:Object.freeze(['invoke'] as const),
  }),
  action:Object.freeze({kind:'invoke' as const}),
});
const first:WindowsUiaSemanticRecipeManifest=Object.freeze({
  schemaVersion:1,recipe:baseRecipe,revision:1,evidenceIds:Object.freeze(['calc-failure-a']),
});
const second:WindowsUiaSemanticRecipeManifest=Object.freeze({
  schemaVersion:1,
  recipe:Object.freeze({...baseRecipe,locator:Object.freeze({...baseRecipe.locator,names:Object.freeze(['Seven','7'])})}),
  revision:2,parentDigest:digestWindowsUiaSemanticRecipeManifest(first),evidenceIds:Object.freeze(['calc-failure-a','calc-success-b']),
});
function episode(overrides:Partial<WindowsUiaSemanticCorrectionEpisode>={}):WindowsUiaSemanticCorrectionEpisode {
  return Object.freeze({
    episodeId:'calc-lifecycle-correction',recipeId:'calculator-add',baseManifestDigest:digestWindowsUiaSemanticRecipeManifest(first),
    trigger:'grounding-missing',evidenceIds:Object.freeze(['calc-failure-a','calc-success-b']),proposedManifest:second,...overrides,
  });
}

test('semantic correction episode is reviewable only as offline no-authority evidence',()=>{
  const result=assessWindowsUiaSemanticCorrectionEpisode(first,episode());
  assert.equal(result.status,'reviewable');
  assert.equal(result.authorityGranted,false);
  assert.equal(result.status==='reviewable'&&result.proposedManifestDigest,digestWindowsUiaSemanticRecipeManifest(second));
  assert.ok(result.evidence.includes('windows-uia-semantic-correction-no-authority'));
});

test('semantic correction episode rejects stale base digest',()=>{
  const result=assessWindowsUiaSemanticCorrectionEpisode(first,episode({baseManifestDigest:`sha256:${'0'.repeat(64)}`}));
  assert.deepEqual([result.status,result.status==='rejected'&&result.reason],['rejected','base-digest-mismatch']);
  assert.equal(result.authorityGranted,false);
});

test('semantic correction episode rejects revision not linked to exact base',()=>{
  const bad=Object.freeze({...second,parentDigest:`sha256:${'1'.repeat(64)}`});
  const result=assessWindowsUiaSemanticCorrectionEpisode(first,episode({proposedManifest:bad}));
  assert.deepEqual([result.status,result.status==='rejected'&&result.reason],['rejected','revision-invalid']);
});

test('semantic correction evidence must be bound into proposed revision provenance',()=>{
  const result=assessWindowsUiaSemanticCorrectionEpisode(first,episode({evidenceIds:Object.freeze(['new-observation'])}));
  assert.deepEqual([result.status,result.status==='rejected'&&result.reason],['rejected','evidence-not-bound-to-revision']);
});

test('semantic correction cannot switch recipe identity or use invalid trigger',()=>{
  const other=Object.freeze({...second,recipe:Object.freeze({...second.recipe,id:'other'})});
  assert.equal(assessWindowsUiaSemanticCorrectionEpisode(first,episode({proposedManifest:other})).status,'rejected');
  const invalid=episode({trigger:'success' as never});
  const result=assessWindowsUiaSemanticCorrectionEpisode(first,invalid);
  assert.deepEqual([result.status,result.status==='rejected'&&result.reason],['rejected','trigger-invalid']);
});
