import type { WindowsUiaCachedObservation, WindowsUiaControlRef, WindowsUiaSemanticAction } from './windowsUiaContract.js';
import { resolveWindowsUiaSemanticLocator, type WindowsUiaSemanticLocator } from './windowsUiaSemanticLocator.js';

const TOKEN=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MAX_VALUE_BYTES=16_384;
const encoder=new TextEncoder();

export type WindowsUiaSemanticActionTemplate =
  | Readonly<{kind:'invoke'}>
  | Readonly<{kind:'toggle'}>
  | Readonly<{kind:'select'}>
  | Readonly<{kind:'set-value';inputKey:string}>
  | Readonly<{kind:'set-range-value';inputKey:string}>
  | Readonly<{kind:'expand-collapse';state:'expanded'|'collapsed'}>
  | Readonly<{kind:'scroll';horizontal:'large-decrement'|'small-decrement'|'no-amount'|'large-increment'|'small-increment';vertical:'large-decrement'|'small-decrement'|'no-amount'|'large-increment'|'small-increment'}>
  | Readonly<{kind:'window';operation:'minimize'|'maximize'|'restore'|'close'}>;

export interface WindowsUiaSemanticActionRecipe {
  /** Stable skill/recipe identity only. It conveys no execution authority. */
  readonly id:string;
  readonly locator:WindowsUiaSemanticLocator;
  readonly action:WindowsUiaSemanticActionTemplate;
}

export type WindowsUiaSemanticRecipeInput = string|number;
export type WindowsUiaSemanticRecipeInputs = Readonly<Record<string,WindowsUiaSemanticRecipeInput>>;

export type WindowsUiaSemanticRecipeInstantiation =
  | Readonly<{status:'ready';recipeId:string;ref:WindowsUiaControlRef;action:WindowsUiaSemanticAction;evidence:readonly string[]}>
  | Readonly<{status:'grounding-missing';recipeId:string;evidence:readonly string[]}>
  | Readonly<{status:'grounding-ambiguous';recipeId:string;candidateCount:number;evidence:readonly string[]}>
  | Readonly<{status:'input-invalid';recipeId:string;inputKey:string;evidence:readonly string[]}>;

function validInputKey(value:unknown):value is string{return typeof value==='string'&&TOKEN.test(value);}
export function validateWindowsUiaSemanticActionRecipe(recipe:WindowsUiaSemanticActionRecipe):void {
  if(!recipe||typeof recipe!=='object'||!TOKEN.test(recipe.id)||!recipe.locator||typeof recipe.locator!=='object'||!recipe.action||typeof recipe.action!=='object')
    throw new Error('windows-uia-semantic-recipe-invalid');
  const action=recipe.action;
  switch(action.kind){
    case'invoke':case'toggle':case'select':break;
    case'set-value':case'set-range-value':if(!validInputKey(action.inputKey))throw new Error('windows-uia-semantic-recipe-input-key-invalid');break;
    case'expand-collapse':if(action.state!=='expanded'&&action.state!=='collapsed')throw new Error('windows-uia-semantic-recipe-action-invalid');break;
    case'scroll':{
      const allowed=new Set(['large-decrement','small-decrement','no-amount','large-increment','small-increment']);
      if(!allowed.has(action.horizontal)||!allowed.has(action.vertical))throw new Error('windows-uia-semantic-recipe-action-invalid');
      break;
    }
    case'window':if(!['minimize','maximize','restore','close'].includes(action.operation))throw new Error('windows-uia-semantic-recipe-action-invalid');break;
    default:throw new Error('windows-uia-semantic-recipe-action-invalid');
  }
}
function inputValue(inputs:WindowsUiaSemanticRecipeInputs,key:string):WindowsUiaSemanticRecipeInput|undefined {
  if(!inputs||typeof inputs!=='object'||Array.isArray(inputs))return undefined;
  const descriptor=Object.getOwnPropertyDescriptor(inputs,key);
  if(!descriptor||!('value'in descriptor)||descriptor.get!==undefined||descriptor.set!==undefined||!descriptor.enumerable)return undefined;
  return descriptor.value as WindowsUiaSemanticRecipeInput;
}
function materializeAction(template:WindowsUiaSemanticActionTemplate,inputs:WindowsUiaSemanticRecipeInputs):WindowsUiaSemanticAction|undefined {
  switch(template.kind){
    case'invoke':return Object.freeze({kind:'invoke'});
    case'toggle':return Object.freeze({kind:'toggle'});
    case'select':return Object.freeze({kind:'select'});
    case'expand-collapse':return Object.freeze({kind:'expand-collapse',state:template.state});
    case'scroll':return Object.freeze({kind:'scroll',horizontal:template.horizontal,vertical:template.vertical});
    case'window':return Object.freeze({kind:'window',operation:template.operation});
    case'set-value':{
      const value=inputValue(inputs,template.inputKey);
      return typeof value==='string'&&!value.includes('\0')&&encoder.encode(value).byteLength<=MAX_VALUE_BYTES?Object.freeze({kind:'set-value',value}):undefined;
    }
    case'set-range-value':{
      const value=inputValue(inputs,template.inputKey);
      return typeof value==='number'&&Number.isFinite(value)?Object.freeze({kind:'set-range-value',value}):undefined;
    }
  }
}

/**
 * Instantiate a portable semantic recipe against one current UIA observation.
 * This is planning/grounding only: the result deliberately contains no effect
 * class, grants, credential authority, input lease, or dispatch method. Callers
 * must submit the ref/action through the normal DP11 coordinator, which revalidates
 * target identity and independently applies window, consequence, dispatch, and
 * post-action verification gates.
 */
export function instantiateWindowsUiaSemanticRecipe(
  observation:WindowsUiaCachedObservation,
  recipe:WindowsUiaSemanticActionRecipe,
  inputs:WindowsUiaSemanticRecipeInputs=Object.freeze({}),
):WindowsUiaSemanticRecipeInstantiation {
  validateWindowsUiaSemanticActionRecipe(recipe);
  const grounding=resolveWindowsUiaSemanticLocator(observation,recipe.locator);
  if(grounding.status==='missing')return Object.freeze({
    status:'grounding-missing' as const,recipeId:recipe.id,evidence:Object.freeze([...grounding.evidence,'windows-uia-semantic-recipe-no-dispatch']),
  });
  if(grounding.status==='ambiguous')return Object.freeze({
    status:'grounding-ambiguous' as const,recipeId:recipe.id,candidateCount:grounding.candidateCount,
    evidence:Object.freeze([...grounding.evidence,'windows-uia-semantic-recipe-no-dispatch']),
  });
  const action=materializeAction(recipe.action,inputs);
  if(!action){
    const inputKey=recipe.action.kind==='set-value'||recipe.action.kind==='set-range-value'?recipe.action.inputKey:'invalid';
    return Object.freeze({
      status:'input-invalid' as const,recipeId:recipe.id,inputKey,
      evidence:Object.freeze([`windows-uia-semantic-recipe-${recipe.id}-input-invalid`,'windows-uia-semantic-recipe-no-dispatch']),
    });
  }
  return Object.freeze({
    status:'ready' as const,recipeId:recipe.id,ref:grounding.ref,action,
    evidence:Object.freeze([...grounding.evidence,`windows-uia-semantic-recipe-${recipe.id}-instantiated`]),
  });
}
