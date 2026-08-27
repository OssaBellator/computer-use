import test from 'node:test';
import assert from 'node:assert/strict';
import { WindowsUiaSemanticRecipeRegistry } from '../src/computer/windowsUiaSemanticRecipeRegistry.js';
import { digestWindowsUiaSemanticRecipeManifest, type WindowsUiaSemanticRecipeManifest } from '../src/computer/windowsUiaSemanticRecipeManifest.js';

function manifest(revision:number,names:readonly string[],parentDigest?:string):WindowsUiaSemanticRecipeManifest {
  return Object.freeze({
    schemaVersion:1,revision,
    ...(parentDigest!==undefined?{parentDigest}:{}),
    evidenceIds:Object.freeze([`evidence-${revision}-${names[0]!.toLowerCase()}`]),
    recipe:Object.freeze({
      id:'save-skill',
      locator:Object.freeze({id:'save-target',names:Object.freeze(names),controlTypes:Object.freeze(['Button']),requiredPatterns:Object.freeze(['invoke'] as const)}),
      action:Object.freeze({kind:'invoke' as const}),
    }),
  });
}

test('review registry resolves only exact recipe id plus digest',()=>{
  const registry=new WindowsUiaSemanticRecipeRegistry();
  const first=manifest(1,['Save']);
  const entry=registry.register(first);
  assert.equal(registry.resolveExact('save-skill',entry.digest)?.digest,entry.digest);
  assert.equal(registry.resolveExact('other-skill',entry.digest),undefined);
  assert.equal(registry.resolveExact('save-skill',`sha256:${'0'.repeat(64)}`),undefined);
});

test('review registry requires exact registered parent before child revision',()=>{
  const registry=new WindowsUiaSemanticRecipeRegistry();
  const first=manifest(1,['Save']);
  const second=manifest(2,['Save','Store'],digestWindowsUiaSemanticRecipeManifest(first));
  assert.throws(()=>registry.register(second),/parent-missing/);
  registry.register(first);
  assert.doesNotThrow(()=>registry.register(second));
});

test('review registry registration is idempotent by immutable manifest digest',()=>{
  const registry=new WindowsUiaSemanticRecipeRegistry();
  const first=manifest(1,['Save']);
  const a=registry.register(first);
  const b=registry.register(first);
  assert.equal(a,b);
  assert.equal(registry.revisions('save-skill').length,1);
});

test('review registry permits candidate branches but requires exact digest selection',()=>{
  const registry=new WindowsUiaSemanticRecipeRegistry();
  const first=manifest(1,['Save']);
  const parent=registry.register(first);
  const a=manifest(2,['Save','Store'],parent.digest);
  const b=manifest(2,['Save','Commit'],parent.digest);
  const aEntry=registry.register(a);
  const bEntry=registry.register(b);
  assert.notEqual(aEntry.digest,bEntry.digest);
  assert.deepEqual(registry.revisions('save-skill').map((entry)=>entry.revision),[1,2,2]);
  assert.equal(registry.resolveExact('save-skill',aEntry.digest)?.manifest.recipe.locator.names?.includes('Store'),true);
  assert.equal(registry.resolveExact('save-skill',bEntry.digest)?.manifest.recipe.locator.names?.includes('Commit'),true);
});

test('review registry exposes no active/latest/promote authority shortcut',()=>{
  const registry=new WindowsUiaSemanticRecipeRegistry();
  registry.register(manifest(1,['Save']));
  assert.equal('active' in registry,false);
  assert.equal('latest' in registry,false);
  assert.equal('promote' in registry,false);
  assert.equal('dispatch' in registry,false);
});
