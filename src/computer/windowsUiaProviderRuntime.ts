import type { ComputerEffectClass, ComputerObservationLimits } from './environmentAdapter.js';
import type {
  WindowsUiaCachedObservation,
  WindowsUiaControlRef,
  WindowsUiaProvider,
  WindowsUiaRevalidation,
  WindowsUiaSemanticAction,
  WindowsUiaWindowRef,
} from './windowsUiaContract.js';
import type { DesktopBackendActionResult } from './desktopUiBackend.js';
import { WindowsUiaCacheState, type WindowsUiaInvalidationReason } from './windowsUiaCacheState.js';

export interface WindowsUiaNativeElementHandle {
  readonly token: string;
}

export interface WindowsUiaCachePlan {
  readonly scope: 'element' | 'children' | 'subtree';
  readonly properties: readonly string[];
  readonly patterns: readonly string[];
  readonly maxItems: number;
  readonly maxDepth: number;
  readonly maxTextBytes: number;
}

export interface WindowsUiaProviderBridge {
  resolveWindow(window: WindowsUiaWindowRef): Promise<{ readonly status:'current'; readonly root:WindowsUiaNativeElementHandle } | { readonly status:'missing'|'stale'|'inaccessible' }>;
  buildCache(root: WindowsUiaNativeElementHandle, plan: WindowsUiaCachePlan, invalidationEpoch:number): Promise<WindowsUiaCachedObservation>;
  resolveControl(ref: WindowsUiaControlRef): Promise<{ readonly status:'candidate'; readonly element:WindowsUiaNativeElementHandle } | { readonly status:'missing'|'ambiguous'|'inaccessible' }>;
  compareElements(a: WindowsUiaNativeElementHandle, b: WindowsUiaNativeElementHandle): Promise<boolean>;
  snapshotControl(element: WindowsUiaNativeElementHandle, ref: WindowsUiaControlRef): Promise<WindowsUiaRevalidation>;
  performPattern(element: WindowsUiaNativeElementHandle, action: WindowsUiaSemanticAction, effect:ComputerEffectClass): Promise<DesktopBackendActionResult>;
}

const DEFAULT_PROPERTIES = Object.freeze([
  'runtime-id','automation-id','control-type','name','value','is-enabled','is-offscreen','bounding-rectangle',
  'window-is-modal','window-interaction-state',
]);
const DEFAULT_PATTERNS = Object.freeze(['invoke','value','toggle','selection-item','expand-collapse','scroll','range-value','window']);

function boundedPlan(limits:Required<ComputerObservationLimits>): WindowsUiaCachePlan {
  return Object.freeze({
    scope: limits.maxDepth <= 1 ? 'children' : 'subtree',
    properties: DEFAULT_PROPERTIES,
    patterns: DEFAULT_PATTERNS,
    maxItems: limits.maxItems,
    maxDepth: limits.maxDepth,
    maxTextBytes: limits.maxTextBytes,
  });
}

/**
 * Provider-facing Windows UIA runtime. COM/Win32 implementations sit behind the
 * bridge; this layer owns bounded cache planning, invalidation epochs, exact
 * element comparison, and semantic-only dispatch policy.
 */
export class WindowsUiaProviderRuntime implements WindowsUiaProvider {
  private readonly cache = new WindowsUiaCacheState();

  constructor(readonly bridge: WindowsUiaProviderBridge) {}

  invalidate(window:WindowsUiaWindowRef, epoch:number, reason:WindowsUiaInvalidationReason): void {
    this.cache.invalidate(window, epoch, reason);
  }

  async observeCached(window:WindowsUiaWindowRef, limits:Required<ComputerObservationLimits>): Promise<WindowsUiaCachedObservation> {
    const resolved = await this.bridge.resolveWindow(window);
    if (resolved.status !== 'current') throw new Error(`windows-uia-window-${resolved.status}`);
    const epoch = this.cache.currentEpoch(window);
    const observation = await this.bridge.buildCache(resolved.root, boundedPlan(limits), epoch);
    if (observation.invalidationEpoch !== epoch) throw new Error('windows-uia-cache-epoch-mismatch');
    this.cache.register(observation);
    return observation;
  }

  async revalidateControl(ref:WindowsUiaControlRef): Promise<WindowsUiaRevalidation> {
    const candidate = await this.bridge.resolveControl(ref);
    if (candidate.status !== 'candidate') return {status:candidate.status};

    const fresh = await this.bridge.snapshotControl(candidate.element, ref);
    if (fresh.status !== 'current') return fresh;
    const currentCandidate = await this.bridge.resolveControl(fresh.control.ref);
    if (currentCandidate.status !== 'candidate') return {status:currentCandidate.status};
    const same = await this.bridge.compareElements(candidate.element, currentCandidate.element);
    if (!same) return {status:'stale',evidence:['windows-uia-compare-elements-mismatch']};
    return fresh;
  }

  async performSemanticAction(ref:WindowsUiaControlRef, action:WindowsUiaSemanticAction, effect:ComputerEffectClass): Promise<DesktopBackendActionResult> {
    const candidate = await this.bridge.resolveControl(ref);
    if (candidate.status !== 'candidate') {
      return {status:candidate.status === 'inaccessible' ? 'unsupported' : 'rejected',dispatched:false,verified:false,evidence:[`windows-uia-${candidate.status}`]};
    }
    return this.bridge.performPattern(candidate.element, action, effect);
  }
}
