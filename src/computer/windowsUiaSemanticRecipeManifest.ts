import { createHash } from 'node:crypto';
import { validateWindowsUiaSemanticActionRecipe, type WindowsUiaSemanticActionRecipe } from './windowsUiaSemanticRecipe.js';

const TOKEN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const DIGEST=/^sha256:[0-9a-f]{64}$/;
const MAX_EVIDENCE=128;

export interface WindowsUiaSemanticRecipeManifest {
  readonly schemaVersion:1;
  readonly recipe:WindowsUiaSemanticActionRecipe;
  readonly revision:number;
  /** Exact digest of the previous manifest. Revision 1 has no parent. */
  readonly parentDigest?:string;
  /** Replay-identifiable observations/corrections used to justify this revision. */
  readonly evidenceIds:readonly string[];
}

function sortedUnique(values:readonly string[],normalizer?:(value:string)=>string):readonly string[]{
  const normalized=normalizer===undefined?values:values.map(normalizer);
  return Object.freeze([...new Set(normalized)].sort());
}

function canonicalRecipe(recipe:WindowsUiaSemanticActionRecipe):unknown {
  const locator=recipe.locator;
  const action=recipe.action;
  return {
    id:recipe.id,
    locator:{
      id:locator.id,
      automationIds:locator.automationIds===undefined?null:sortedUnique(locator.automationIds),
      names:locator.names===undefined?null:sortedUnique(locator.names,(value)=>value.toLocaleLowerCase('en-US')),
      controlTypes:sortedUnique(locator.controlTypes),
      requiredPatterns:sortedUnique(locator.requiredPatterns??[]),
      requireEnabled:locator.requireEnabled??true,
      includeOffscreen:locator.includeOffscreen??false,
    },
    action:{...action},
  };
}

function validateManifest(manifest:WindowsUiaSemanticRecipeManifest):void {
  if(!manifest||typeof manifest!=='object'||manifest.schemaVersion!==1||!manifest.recipe||typeof manifest.recipe!=='object')
    throw new Error('windows-uia-semantic-recipe-manifest-invalid');
  validateWindowsUiaSemanticActionRecipe(manifest.recipe);
  if(!TOKEN.test(manifest.recipe.id)||!Number.isSafeInteger(manifest.revision)||manifest.revision<1)
    throw new Error('windows-uia-semantic-recipe-manifest-revision-invalid');
  if(!Array.isArray(manifest.evidenceIds)||manifest.evidenceIds.length>MAX_EVIDENCE||
    manifest.evidenceIds.some((id)=>typeof id!=='string'||!TOKEN.test(id))||new Set(manifest.evidenceIds).size!==manifest.evidenceIds.length)
    throw new Error('windows-uia-semantic-recipe-manifest-evidence-invalid');
  if(manifest.revision===1){
    if(manifest.parentDigest!==undefined)throw new Error('windows-uia-semantic-recipe-manifest-parent-invalid');
  }else if(typeof manifest.parentDigest!=='string'||!DIGEST.test(manifest.parentDigest)){
    throw new Error('windows-uia-semantic-recipe-manifest-parent-invalid');
  }
}

function digestValidatedManifest(manifest:WindowsUiaSemanticRecipeManifest):string {
  const canonical={
    schemaVersion:1,
    recipe:canonicalRecipe(manifest.recipe),
    revision:manifest.revision,
    parentDigest:manifest.parentDigest??null,
    evidenceIds:sortedUnique(manifest.evidenceIds),
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical),'utf8').digest('hex')}`;
}

/**
 * Stable content identity for a portable semantic recipe revision. The digest
 * covers recipe semantics, revision lineage and bounded provenance only; it does
 * not encode effect authority, grants, credentials, leases or dispatch state.
 */
export function digestWindowsUiaSemanticRecipeManifest(manifest:WindowsUiaSemanticRecipeManifest):string {
  validateManifest(manifest);
  return digestValidatedManifest(manifest);
}

/** Validate an immutable correction/revision link without granting execution authority. */
export function validateWindowsUiaSemanticRecipeRevision(
  previous:WindowsUiaSemanticRecipeManifest,
  next:WindowsUiaSemanticRecipeManifest,
):void {
  validateManifest(previous);
  validateManifest(next);
  if(previous.recipe.id!==next.recipe.id)throw new Error('windows-uia-semantic-recipe-revision-id-mismatch');
  if(next.revision!==previous.revision+1)throw new Error('windows-uia-semantic-recipe-revision-sequence-invalid');
  if(next.parentDigest!==digestValidatedManifest(previous))
    throw new Error('windows-uia-semantic-recipe-revision-parent-mismatch');
}
