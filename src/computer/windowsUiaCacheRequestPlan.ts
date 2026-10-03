import type { ComputerObservationLimits } from './environmentAdapter.js';

export const WINDOWS_UIA_CACHE_PROPERTIES = Object.freeze([
  'runtime-id','automation-id','control-type','name','value','is-enabled','is-offscreen','bounding-rectangle',
  'native-window-handle','process-id','window-is-modal','window-interaction-state',
] as const);

export const WINDOWS_UIA_CACHE_PATTERNS = Object.freeze([
  'invoke','value','toggle','selection-item','expand-collapse','scroll','range-value','window',
] as const);

export interface WindowsUiaCacheRequestPlan {
  readonly treeScope:'element'|'element-and-children'|'element-and-descendants';
  readonly controlViewOnly:true;
  readonly elementMode:'full';
  readonly properties:readonly string[];
  readonly patterns:readonly string[];
  readonly maxItems:number;
  readonly maxDepth:number;
  readonly maxTextBytes:number;
}

const HARD_MAX_ITEMS = 10_000;
const HARD_MAX_DEPTH = 128;
const HARD_MAX_TEXT_BYTES = 1_000_000;

function boundedInteger(value:number|undefined, fallback:number, hardMax:number):number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('windows-uia-cache-limit-invalid');
  return Math.min(value,hardMax);
}

/**
 * Builds the immutable request description consumed by the native
 * IUIAutomationCacheRequest bridge. `elementMode: full` is intentional because
 * semantic control-pattern methods cannot be invoked on cache-only elements.
 */
export function buildWindowsUiaCacheRequestPlan(limits?:ComputerObservationLimits):WindowsUiaCacheRequestPlan {
  const maxItems = boundedInteger(limits?.maxItems,256,HARD_MAX_ITEMS);
  const maxDepth = boundedInteger(limits?.maxDepth,16,HARD_MAX_DEPTH);
  const maxTextBytes = boundedInteger(limits?.maxTextBytes,16_384,HARD_MAX_TEXT_BYTES);
  return Object.freeze({
    treeScope:maxDepth === 1 ? 'element-and-children' : 'element-and-descendants',
    controlViewOnly:true,
    elementMode:'full',
    properties:WINDOWS_UIA_CACHE_PROPERTIES,
    patterns:WINDOWS_UIA_CACHE_PATTERNS,
    maxItems,
    maxDepth,
    maxTextBytes,
  });
}
