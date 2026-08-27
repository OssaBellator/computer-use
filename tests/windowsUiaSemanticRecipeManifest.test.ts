import test from 'node:test';
import assert from 'node:assert/strict';
import {
  digestWindowsUiaSemanticRecipeManifest,
  validateWindowsUiaSemanticRecipeRevision,
  type WindowsUiaSemanticRecipeManifest,
} from '../src/computer/windowsUiaSemanticRecipeManifest.js';
import type { WindowsUiaSemanticActionRecipe } from '../src/computer/windowsUiaSemanticRecipe.js';

function recipe(overrides:Partial<WindowsUiaSemanticActionRecipe>={}):WindowsUiaSemanticActionRecipe {
  return Object.freeze({
    id:'save-document',
    locator:Object.freeze({
      id:'save-target',automationIds:Object.freeze(['saveButton','cmdSave']),names:Object.freeze(['Save','SAVE']),
      controlTypes:Object.freeze(['Button']),requiredPatterns:Object.freeze(['invoke'] as const),
    }),
    action:Object.freeze({kind:'invoke' as const}),
    ...overrides,
  });
}
function manifest(recipeValue=recipe(),overrides:Partial<WindowsUiaSemanticRecipeManifest>={}):WindowsUiaSemanticRecipeManifest {
  return Object.freeze({schemaVersion:1 as const,recipe:recipeValue,revision:1,evidenceIds:Object.freeze(['obs-a','correction-b']),...overrides});
}

test('semantic recipe manifest digest is stable across unordered locator and evidence alternatives',()=>{
  const first=manifest();
  const second=manifest(Object.freeze({
    ...recipe(),
    locator:Object.freeze({
      id:'save-target',automationIds:Object.freeze(['cmdSave','saveButton']),names:Object.freeze(['save']),
      controlTypes:Object.freeze(['Button']),requiredPatterns:Object.freeze(['invoke'] as const),requireEnabled:true,includeOffscreen:false,
    }),
  }),{evidenceIds:Object.freeze(['correction-b','obs-a'])});
  assert.equal(digestWindowsUiaSemanticRecipeManifest(first),digestWindowsUiaSemanticRecipeManifest(second));
});

test('semantic recipe manifest digest changes when recipe semantics change',()=>{
  const first=manifest();
  const changed=manifest(Object.freeze({...recipe(),action:Object.freeze({kind:'toggle' as const})}));
  assert.notEqual(digestWindowsUiaSemanticRecipeManifest(first),digestWindowsUiaSemanticRecipeManifest(changed));
});

test('semantic recipe revision must link to exact previous digest and increment once',()=>{
  const first=manifest();
  const second=manifest(recipe(),{
    revision:2,parentDigest:digestWindowsUiaSemanticRecipeManifest(first),evidenceIds:Object.freeze(['obs-c']),
  });
  assert.doesNotThrow(()=>validateWindowsUiaSemanticRecipeRevision(first,second));
  assert.throws(()=>validateWindowsUiaSemanticRecipeRevision(first,Object.freeze({...second,parentDigest:`sha256:${'0'.repeat(64)}`})),/parent-mismatch/);
  assert.throws(()=>validateWindowsUiaSemanticRecipeRevision(first,Object.freeze({...second,revision:3})),/sequence-invalid/);
});

test('semantic recipe revision cannot silently switch recipe identity',()=>{
  const first=manifest();
  const second=manifest(recipe({id:'other-recipe'}),{
    revision:2,parentDigest:digestWindowsUiaSemanticRecipeManifest(first),evidenceIds:Object.freeze(['obs-c']),
  });
  assert.throws(()=>validateWindowsUiaSemanticRecipeRevision(first,second),/id-mismatch/);
});

test('semantic recipe manifest validates nested recipe content at runtime',()=>{
  const malformed=manifest(Object.freeze({...recipe(),action:Object.freeze({kind:'bogus'} as never)}));
  assert.throws(()=>digestWindowsUiaSemanticRecipeManifest(malformed),/recipe-action-invalid/);
  assert.throws(()=>digestWindowsUiaSemanticRecipeManifest(manifest(recipe(),{revision:2})),/parent-invalid/);
  assert.throws(()=>digestWindowsUiaSemanticRecipeManifest(manifest(recipe(),{evidenceIds:Object.freeze(['bad evidence'])})),/evidence-invalid/);
});
