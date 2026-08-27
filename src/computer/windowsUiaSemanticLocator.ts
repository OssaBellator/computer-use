import type {
  WindowsUiaCachedObservation,
  WindowsUiaControlRef,
  WindowsUiaControlSnapshot,
  WindowsUiaPattern,
} from './windowsUiaContract.js';

const ID=/^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const MAX_ALTERNATIVES=16;
const MAX_TEXT_BYTES=512;
const encoder=new TextEncoder();

export interface WindowsUiaSemanticLocator {
  /** Stable plan-local identity only; never an OS/UI authority identity. */
  readonly id:string;
  /** Exact provider automation-id alternatives, strongest locator tier. */
  readonly automationIds?:readonly string[];
  /** Exact case-insensitive semantic-name alternatives, used only if no automation-id match exists. */
  readonly names?:readonly string[];
  readonly controlTypes:readonly string[];
  readonly requiredPatterns?:readonly WindowsUiaPattern[];
  /** Defaults true so disabled controls are not selected accidentally. */
  readonly requireEnabled?:boolean;
  /** Defaults false so hidden/offscreen controls do not silently win. */
  readonly includeOffscreen?:boolean;
}

export type WindowsUiaSemanticLocatorResolution =
  | Readonly<{status:'matched';ref:WindowsUiaControlRef;basis:'automation-id'|'semantic-name';evidence:readonly string[]}>
  | Readonly<{status:'missing';evidence:readonly string[]}>
  | Readonly<{status:'ambiguous';basis:'automation-id'|'semantic-name';candidateCount:number;evidence:readonly string[]}>;

function boundedText(value:unknown):value is string {
  return typeof value==='string'&&value.length>0&&!value.includes('\0')&&encoder.encode(value).byteLength<=MAX_TEXT_BYTES;
}
function validAlternatives(value:unknown):value is readonly string[] {
  return Array.isArray(value)&&value.length>0&&value.length<=MAX_ALTERNATIVES&&
    value.every(boundedText)&&new Set(value).size===value.length;
}
function validateLocator(locator:WindowsUiaSemanticLocator):void {
  if(!locator||typeof locator!=='object'||!ID.test(locator.id))throw new Error('windows-uia-semantic-locator-id-invalid');
  if(!validAlternatives(locator.controlTypes))throw new Error('windows-uia-semantic-locator-control-types-invalid');
  if(locator.automationIds!==undefined&&!validAlternatives(locator.automationIds))throw new Error('windows-uia-semantic-locator-automation-ids-invalid');
  if(locator.names!==undefined&&!validAlternatives(locator.names))throw new Error('windows-uia-semantic-locator-names-invalid');
  if(locator.automationIds===undefined&&locator.names===undefined)throw new Error('windows-uia-semantic-locator-identity-missing');
  if(locator.requiredPatterns!==undefined){
    if(!Array.isArray(locator.requiredPatterns)||locator.requiredPatterns.length>8||new Set(locator.requiredPatterns).size!==locator.requiredPatterns.length)
      throw new Error('windows-uia-semantic-locator-patterns-invalid');
    const allowed=new Set<WindowsUiaPattern>(['invoke','value','toggle','selection-item','expand-collapse','scroll','range-value','window']);
    if(locator.requiredPatterns.some((pattern)=>!allowed.has(pattern)))throw new Error('windows-uia-semantic-locator-patterns-invalid');
  }
  if(locator.requireEnabled!==undefined&&typeof locator.requireEnabled!=='boolean')throw new Error('windows-uia-semantic-locator-enabled-invalid');
  if(locator.includeOffscreen!==undefined&&typeof locator.includeOffscreen!=='boolean')throw new Error('windows-uia-semantic-locator-offscreen-invalid');
}

function flatten(root:WindowsUiaControlSnapshot|undefined):readonly WindowsUiaControlSnapshot[] {
  if(!root)return Object.freeze([]);
  const result:WindowsUiaControlSnapshot[]=[];
  const stack=[root];
  while(stack.length>0){
    const current=stack.pop()!;
    result.push(current);
    const children=current.children??[];
    for(let index=children.length-1;index>=0;index-=1)stack.push(children[index]!);
  }
  return Object.freeze(result);
}
function eligible(node:WindowsUiaControlSnapshot,locator:WindowsUiaSemanticLocator):boolean {
  if(!locator.controlTypes.includes(node.ref.controlType))return false;
  if((locator.requireEnabled??true)&&node.enabled===false)return false;
  if(!(locator.includeOffscreen??false)&&node.offscreen===true)return false;
  for(const pattern of locator.requiredPatterns??[])if(!node.patterns.includes(pattern))return false;
  return true;
}
function refIdentity(ref:WindowsUiaControlRef):string {
  return `${ref.window.hwnd}:${ref.window.generation}:${ref.generation}:${ref.runtimeId.join('.')}`;
}
function unique(nodes:readonly WindowsUiaControlSnapshot[]):readonly WindowsUiaControlSnapshot[] {
  const seen=new Set<string>();
  return Object.freeze(nodes.filter((node)=>{
    const identity=refIdentity(node.ref);
    if(seen.has(identity))return false;
    seen.add(identity);
    return true;
  }));
}
function resolution(nodes:readonly WindowsUiaControlSnapshot[],basis:'automation-id'|'semantic-name',id:string):WindowsUiaSemanticLocatorResolution|undefined {
  const candidates=unique(nodes);
  if(candidates.length===0)return undefined;
  if(candidates.length>1)return Object.freeze({
    status:'ambiguous' as const,basis,candidateCount:candidates.length,
    evidence:Object.freeze([`windows-uia-semantic-locator-${id}-${basis}-ambiguous`]),
  });
  return Object.freeze({
    status:'matched' as const,ref:candidates[0]!.ref,basis,
    evidence:Object.freeze([`windows-uia-semantic-locator-${id}-${basis}-matched`]),
  });
}

/**
 * Resolve a portable semantic target description against one already-bounded UIA
 * observation. Automation IDs outrank semantic names; ambiguity at either active
 * tier fails closed. The returned ref is only a grounding candidate and must still
 * pass normal revalidation, window/modal authority, consequence, and verification
 * gates before any action can dispatch.
 */
export function resolveWindowsUiaSemanticLocator(
  observation:WindowsUiaCachedObservation,
  locator:WindowsUiaSemanticLocator,
):WindowsUiaSemanticLocatorResolution {
  validateLocator(locator);
  const nodes=flatten(observation.root).filter((node)=>eligible(node,locator));
  if(locator.automationIds!==undefined){
    const matched=resolution(nodes.filter((node)=>node.ref.automationId!==undefined&&locator.automationIds!.includes(node.ref.automationId)), 'automation-id',locator.id);
    if(matched)return matched;
  }
  if(locator.names!==undefined){
    const names=new Set(locator.names.map((name)=>name.toLocaleLowerCase('en-US')));
    const matched=resolution(nodes.filter((node)=>node.name!==undefined&&names.has(node.name.toLocaleLowerCase('en-US'))), 'semantic-name',locator.id);
    if(matched)return matched;
  }
  return Object.freeze({status:'missing' as const,evidence:Object.freeze([`windows-uia-semantic-locator-${locator.id}-missing`])});
}
