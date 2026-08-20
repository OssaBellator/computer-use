import type { CdpSessionLike } from './cdpIdentity.js';
import {
  captureCdpBrowserState,
  type BrowserDocumentReadyState,
  type BrowserStateSnapshot,
} from './browserState.js';

export type NavigationWaitUntil = 'commit' | 'interactive' | 'complete';
export type BrowserNavigationStatus =
  | 'navigated'
  | 'navigation-error'
  | 'timeout'
  | 'unsupported'
  | 'policy-blocked';

export interface NavigationPolicy {
  /** Exact allowed HTTP(S) origins, e.g. https://example.com. Empty/undefined means no origin allowlist. */
  allowedOrigins?: readonly string[];
  allowHttp?: boolean;
  allowHttps?: boolean;
  allowAbout?: boolean;
  /** Disabled by default because data: embeds executable/document content in the destination itself. */
  allowData?: boolean;
  /** Disabled by default to prevent credentials from being smuggled in navigation URLs. */
  allowUrlCredentials?: boolean;
}

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
  policyReason?: string;
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

function normalizeAllowedOrigins(origins: readonly string[] | undefined): Set<string> | undefined {
  if (!origins?.length) return undefined;
  const normalized = new Set<string>();
  for (const value of origins) {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`Navigation allowedOrigins must contain HTTP(S) origins: ${value}`);
    }
    if (parsed.pathname !== '/' || parsed.search || parsed.hash || parsed.username || parsed.password) {
      throw new Error(`Navigation allowedOrigins entries must be origins, not full URLs: ${value}`);
    }
    normalized.add(parsed.origin);
  }
  return normalized;
}

function policyReasonForUrl(
  parsed: URL,
  policy: NavigationPolicy,
  allowedOrigins: Set<string> | undefined,
): string | undefined {
  if ((parsed.username || parsed.password) && policy.allowUrlCredentials !== true) {
    return 'URL credentials are not allowed';
  }
  switch (parsed.protocol) {
    case 'http:':
      if (policy.allowHttp === false) return 'HTTP navigation is disabled';
      if (allowedOrigins && !allowedOrigins.has(parsed.origin)) return `origin is not allowlisted: ${parsed.origin}`;
      return undefined;
    case 'https:':
      if (policy.allowHttps === false) return 'HTTPS navigation is disabled';
      if (allowedOrigins && !allowedOrigins.has(parsed.origin)) return `origin is not allowlisted: ${parsed.origin}`;
      return undefined;
    case 'about:':
      return policy.allowAbout === false ? 'about: navigation is disabled' : undefined;
    case 'data:':
      return policy.allowData === true ? undefined : 'data: navigation is disabled by default';
    default:
      return `unsupported navigation URL scheme: ${parsed.protocol}`;
  }
}

function parseAbsoluteUrl(url: string): URL {
  try {
    return new URL(url);
  } catch {
    throw new Error(`Navigation URL must be absolute: ${url}`);
  }
}

/** Public policy check shared by top-level navigation and new-tab creation. */
export function navigationPolicyViolation(
  url: string,
  policy: NavigationPolicy = {},
): string | undefined {
  const parsed = parseAbsoluteUrl(url);
  return policyReasonForUrl(parsed, policy, normalizeAllowedOrigins(policy.allowedOrigins));
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/** CDP-backed, browser-authoritative top-level navigation with bounded settling and origin policy. */
export class CdpNavigationController implements BrowserNavigator {
  private readonly allowedOrigins?: Set<string>;

  constructor(
    private readonly session: CdpSessionLike,
    readonly policy: NavigationPolicy = {},
  ) {
    this.allowedOrigins = normalizeAllowedOrigins(policy.allowedOrigins);
  }

  async navigate(url: string, options: BrowserNavigationOptions = {}): Promise<BrowserNavigationResult> {
    const parsed = parseAbsoluteUrl(url);
    const preflightReason = policyReasonForUrl(parsed, this.policy, this.allowedOrigins);
    if (preflightReason) {
      return { status: 'policy-blocked', requestedUrl: url, policyReason: preflightReason, polls: 0 };
    }

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
        if (navigationCommitted(before, after)) {
          const finalReason = policyReasonForUrl(parseAbsoluteUrl(after.url), this.policy, this.allowedOrigins);
          if (finalReason) {
            return {
              status: 'policy-blocked',
              requestedUrl: url,
              before,
              after,
              frameId: result.frameId,
              loaderId: result.loaderId,
              policyReason: `final URL blocked by navigation policy: ${finalReason}`,
              polls,
            };
          }
        }
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
