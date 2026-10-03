import {
  digestWindowsUiaSemanticRecipeManifest,
  validateWindowsUiaSemanticRecipeRevision,
  type WindowsUiaSemanticRecipeManifest,
} from './windowsUiaSemanticRecipeManifest.js';

export interface WindowsUiaSemanticRecipeRegistryEntry {
  readonly recipeId:string;
  readonly revision:number;
  readonly digest:string;
  readonly parentDigest?:string;
  readonly manifest:WindowsUiaSemanticRecipeManifest;
}

/**
 * Review/replay catalog for immutable semantic recipe manifests.
 *
 * Registration is not activation. The registry intentionally has no `latest`,
 * `active`, `promote`, or dispatch API: callers must select an exact digest and
 * execution still goes through the normal DP11 authority pipeline elsewhere.
 */
export class WindowsUiaSemanticRecipeRegistry {
  private readonly byDigest=new Map<string,WindowsUiaSemanticRecipeRegistryEntry>();
  private readonly byRecipe=new Map<string,WindowsUiaSemanticRecipeRegistryEntry[]>();

  register(manifest:WindowsUiaSemanticRecipeManifest):WindowsUiaSemanticRecipeRegistryEntry {
    const digest=digestWindowsUiaSemanticRecipeManifest(manifest);
    const existing=this.byDigest.get(digest);
    if(existing)return existing;
    if(manifest.revision>1){
      const parent=this.byDigest.get(manifest.parentDigest!);
      if(!parent)throw new Error('windows-uia-semantic-recipe-registry-parent-missing');
      validateWindowsUiaSemanticRecipeRevision(parent.manifest,manifest);
    }
    const entry=Object.freeze({
      recipeId:manifest.recipe.id,revision:manifest.revision,digest,
      ...(manifest.parentDigest!==undefined?{parentDigest:manifest.parentDigest}:{}),manifest,
    });
    this.byDigest.set(digest,entry);
    const entries=this.byRecipe.get(entry.recipeId)??[];
    entries.push(entry);
    entries.sort((a,b)=>a.revision-b.revision||a.digest.localeCompare(b.digest));
    this.byRecipe.set(entry.recipeId,entries);
    return entry;
  }

  resolveExact(recipeId:string,digest:string):WindowsUiaSemanticRecipeRegistryEntry|undefined {
    const entry=this.byDigest.get(digest);
    return entry?.recipeId===recipeId?entry:undefined;
  }

  revisions(recipeId:string):readonly Readonly<{revision:number;digest:string;parentDigest?:string}>[] {
    return Object.freeze((this.byRecipe.get(recipeId)??[]).map((entry)=>Object.freeze({
      revision:entry.revision,digest:entry.digest,...(entry.parentDigest!==undefined?{parentDigest:entry.parentDigest}:{}),
    })));
  }
}
