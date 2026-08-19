import type { CdpSessionLike } from './cdpIdentity.js';
import {
  captureCdpBrowserState,
  type BrowserDocumentReadyState,
  type BrowserStateSnapshot,
} from './browserState.js';

export type NavigationWaitUntil = 'commit' | 'interactive' | 'complete';
export type BrowserNavigationStatus = 'navigated' | 'navigation-error' | 'timeout' | 'unsupported';

export interface BrowserNavigationOptions {
  waitUntil?: NavigationWaitUntil;
  timeoutMs?: number;
  maxPolls?: number;
  pollIntervalMs?: number;
}

export interface BrowserNavigationResult {
  status: BrowserNavigationStatus;
  requestedUrl: string;
  before?: BrowserStateSnapshot;
  after?: BrowserStateSnapshot;
  frameId?: string;
  loaderId?: string;
  errorText?: string;
  polls: number;
}

export interface BrowserNavigator {
  navigate(url: string, options?: BrowserNavigationOptions): Promise<BrowserNavigationResult>;
}

function normalizedPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

function readyStateRank(state: BrowserDocumentReadyState): number {
  return state === 'complete' ? 2 : state === 'interactive' ? 1 : 0;
}

function navigationCommitted(
  before: BrowserStateSnapshot | undefined,
  after: BrowserStateSnapshot,
): boolean {
  if (!before) return true;
  return after.url !== before.url || after.timeOrigin !== before.timeOrigin;
}

function waitSatisfied(
  before: BrowserStateSnapshot | undefined,
  state: BrowserStateSnapshot,
  waitUntil: NavigationWaitUntil,
): boolean {
  if (!navigationCommitted(before, state)) return false;
  if (waitUntil === 'commit') return true;
  return readyStateRank(state.readyState) >= readyStateRank(waitUntil);
}

function validateAbsoluteUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Navigation URL must be absolute: ${url}`);
  }
  if (!['http:', 'https:', 'about:', 'data:'].includes(parsed.protocol)) {
    throw new Error(`Unsupported navigation URL scheme: ${parsed.protocol}`);
  }
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** CDP-backed, browser-authoritative top-level navigation with bounded settling. */
export class CdpNavigationController implements BrowserNavigator {
  constructor(private readonly session: CdpSessionLike) {}

  async navigate(url: string, options: BrowserNavigationOptions = {}): Promise<BrowserNavigationResult> {
    validateAbsoluteUrl(url);
    const waitUntil = options.waitUntil ?? 'complete';
    const maxPolls = normalizedPositiveInteger(options.maxPolls, 100);
    const timeoutMs = Math.max(1, options.timeoutMs ?? 10_000);
    const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 25);
    let before: BrowserStateSnapshot | undefined;
    try {
      before = await captureCdpBrowserState(this.session);
    } catch {
      // A navigation can still succeed if the old execution context is unavailable.
    }

    const result = await this.session.send('Page.navigate', { url }) as {
      frameId?: string;
      loaderId?: string;
      errorText?: string;
    };
    if (result.errorText) {
      return {
        status: 'navigation-error',
        requestedUrl: url,
        before,
        frameId: result.frameId,
        loaderId: result.loaderId,
        errorText: result.errorText,
        polls: 0,
      };
    }

    const deadline = Date.now() + timeoutMs;
    let after: BrowserStateSnapshot | undefined;
    let polls = 0;
    while (polls < maxPolls && Date.now() <= deadline) {
      polls += 1;
      try {
        after = await captureCdpBrowserState(this.session);
        if (waitSatisfied(before, after, waitUntil)) {
          return {
            status: 'navigated',
            requestedUrl: url,
            before,
            after,
            frameId: result.frameId,
            loaderId: result.loaderId,
            polls,
          };
        }
      } catch {
        // Runtime execution contexts are transiently unavailable during commit.
      }
      if (polls < maxPolls && Date.now() <= deadline) await sleep(pollIntervalMs);
    }

    return {
      status: 'timeout',
      requestedUrl: url,
      before,
      after,
      frameId: result.frameId,
      loaderId: result.loaderId,
      polls,
    };
  }
}
