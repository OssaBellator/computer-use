import type { CdpSessionLike } from './cdpIdentity.js';
import {
  captureCdpBrowserState,
  type BrowserDocumentReadyState,
  type BrowserStateSnapshot,
} from './browserState.js';
import {
  navigationPolicyViolation,
  type BrowserNavigationOptions,
  type NavigationPolicy,
  type NavigationWaitUntil,
} from './navigationController.js';

export type BrowserHistoryAction = 'back' | 'forward' | 'reload';
export type BrowserHistoryStatus =
  | 'navigated'
  | 'no-history'
  | 'navigation-error'
  | 'timeout'
  | 'policy-blocked';

export interface BrowserHistoryOptions extends BrowserNavigationOptions {
  /** Applies only to reload. */
  ignoreCache?: boolean;
}

export interface BrowserHistoryResult {
  status: BrowserHistoryStatus;
  action: BrowserHistoryAction;
  before?: BrowserStateSnapshot;
  after?: BrowserStateSnapshot;
  policyReason?: string;
  errorText?: string;
  polls: number;
}

export interface BrowserHistoryController {
  back(options?: BrowserHistoryOptions): Promise<BrowserHistoryResult>;
  forward(options?: BrowserHistoryOptions): Promise<BrowserHistoryResult>;
  reload(options?: BrowserHistoryOptions): Promise<BrowserHistoryResult>;
}

interface CdpHistoryEntry {
  id: number;
  url: string;
}

interface CdpNavigationHistory {
  currentIndex: number;
  entries: CdpHistoryEntry[];
}

function normalizedPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function readyStateRank(state: BrowserDocumentReadyState): number {
  return state === 'complete' ? 2 : state === 'interactive' ? 1 : 0;
}

function documentTransitioned(before: BrowserStateSnapshot, after: BrowserStateSnapshot): boolean {
  return after.url !== before.url || after.timeOrigin !== before.timeOrigin;
}

function waitSatisfied(
  before: BrowserStateSnapshot,
  after: BrowserStateSnapshot,
  waitUntil: NavigationWaitUntil,
): boolean {
  if (!documentTransitioned(before, after)) return false;
  if (waitUntil === 'commit') return true;
  return readyStateRank(after.readyState) >= readyStateRank(waitUntil);
}

async function sleep(ms: number): Promise<void> {
  if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * CDP history/reload controller. History destinations are inspected only long
 * enough to enforce navigation policy; URL/title metadata is never retained as
 * controller state or emitted into task traces.
 */
export class CdpHistoryController implements BrowserHistoryController {
  constructor(
    private readonly session: CdpSessionLike,
    readonly policy: NavigationPolicy = {},
  ) {}

  back(options: BrowserHistoryOptions = {}): Promise<BrowserHistoryResult> {
    return this.traverse('back', -1, options);
  }

  forward(options: BrowserHistoryOptions = {}): Promise<BrowserHistoryResult> {
    return this.traverse('forward', 1, options);
  }

  async reload(options: BrowserHistoryOptions = {}): Promise<BrowserHistoryResult> {
    const action: BrowserHistoryAction = 'reload';
    let before: BrowserStateSnapshot;
    try {
      before = await captureCdpBrowserState(this.session);
    } catch {
      return {
        status: 'navigation-error', action,
        errorText: 'browser state unavailable before reload', polls: 0,
      };
    }

    const policyReason = navigationPolicyViolation(before.url, this.policy);
    if (policyReason) {
      return { status: 'policy-blocked', action, before, policyReason, polls: 0 };
    }

    try {
      await this.session.send('Page.reload', { ignoreCache: options.ignoreCache === true });
    } catch (error) {
      return {
        status: 'navigation-error', action, before,
        errorText: error instanceof Error ? error.message : String(error), polls: 0,
      };
    }
    return this.settle(action, before, options);
  }

  private async traverse(
    action: 'back' | 'forward',
    delta: -1 | 1,
    options: BrowserHistoryOptions,
  ): Promise<BrowserHistoryResult> {
    let before: BrowserStateSnapshot;
    try {
      before = await captureCdpBrowserState(this.session);
    } catch {
      return {
        status: 'navigation-error', action,
        errorText: 'browser state unavailable before history traversal', polls: 0,
      };
    }

    let history: CdpNavigationHistory;
    try {
      history = await this.session.send('Page.getNavigationHistory') as CdpNavigationHistory;
    } catch (error) {
      return {
        status: 'navigation-error', action, before,
        errorText: error instanceof Error ? error.message : String(error), polls: 0,
      };
    }

    const entry = history.entries[history.currentIndex + delta];
    if (!entry) return { status: 'no-history', action, before, polls: 0 };

    const policyReason = navigationPolicyViolation(entry.url, this.policy);
    if (policyReason) {
      return { status: 'policy-blocked', action, before, policyReason, polls: 0 };
    }

    try {
      await this.session.send('Page.navigateToHistoryEntry', { entryId: entry.id });
    } catch (error) {
      return {
        status: 'navigation-error', action, before,
        errorText: error instanceof Error ? error.message : String(error), polls: 0,
      };
    }
    return this.settle(action, before, options);
  }

  private async settle(
    action: BrowserHistoryAction,
    before: BrowserStateSnapshot,
    options: BrowserHistoryOptions,
  ): Promise<BrowserHistoryResult> {
    const waitUntil = options.waitUntil ?? 'complete';
    const maxPolls = normalizedPositiveInteger(options.maxPolls, 100);
    const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
    const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 25);
    const deadline = Date.now() + timeoutMs;
    let after: BrowserStateSnapshot | undefined;
    let polls = 0;

    while (polls < maxPolls && Date.now() <= deadline) {
      polls += 1;
      try {
        after = await captureCdpBrowserState(this.session);
        if (documentTransitioned(before, after)) {
          const finalPolicyReason = navigationPolicyViolation(after.url, this.policy);
          if (finalPolicyReason) {
            return {
              status: 'policy-blocked', action, before, after,
              policyReason: `final URL blocked by navigation policy: ${finalPolicyReason}`,
              polls,
            };
          }
        }
        if (waitSatisfied(before, after, waitUntil)) {
          return { status: 'navigated', action, before, after, polls };
        }
      } catch {
        // Cross-document history traversal/reload can transiently destroy contexts.
      }
      if (polls < maxPolls && Date.now() <= deadline) await sleep(pollIntervalMs);
    }
    return { status: 'timeout', action, before, after, polls };
  }
}
