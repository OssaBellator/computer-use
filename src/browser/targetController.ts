import type {
  CdpEventSessionLike,
} from './dialogController.js';
import {
  navigationPolicyViolation,
  type NavigationPolicy,
} from './navigationController.js';

export interface BrowserTargetState {
  targetId: string;
  type: string;
  attached: boolean;
  openerId?: string;
  /** Monotonic creation sequence; no target title/URL/page text is retained. */
  sequence: number;
}

export interface BrowserTargetSummary {
  total: number;
  pages: number;
  unattachedPages: number;
  latestPage?: BrowserTargetState;
  latestUnattachedPage?: BrowserTargetState;
}

export type CreateBrowserTargetStatus = 'created' | 'policy-blocked' | 'protocol-error';
export interface CreateBrowserTargetResult {
  status: CreateBrowserTargetStatus;
  requestedUrl: string;
  targetId?: string;
  policyReason?: string;
  errorText?: string;
}

export type CloseBrowserTargetStatus = 'closed' | 'not-found' | 'attached-target-blocked' | 'protocol-error';
export interface CloseBrowserTargetResult {
  status: CloseBrowserTargetStatus;
  targetId: string;
  errorText?: string;
}

export interface BrowserTargetControllerOptions {
  navigationPolicy?: NavigationPolicy;
  /** Do not let generic close operations tear down the currently attached page unless explicitly overridden. */
  protectAttachedTargets?: boolean;
}

interface RawTargetInfo {
  targetId?: string;
  type?: string;
  attached?: boolean;
  openerId?: string;
}

function cloneTarget(target: BrowserTargetState): BrowserTargetState {
  return { ...target };
}

/**
 * Tracks tabs/popups through the CDP Target domain without retaining their URL/title text.
 * Creation destinations are checked by the same navigation policy as top-level navigation.
 */
export class CdpTargetController {
  private readonly targetsById = new Map<string, BrowserTargetState>();
  private sequence = 0;
  private started = false;
  readonly navigationPolicy: NavigationPolicy;
  readonly protectAttachedTargets: boolean;

  private readonly onCreated = (params: any) => {
    this.upsert(params?.targetInfo);
  };

  private readonly onInfoChanged = (params: any) => {
    this.upsert(params?.targetInfo);
  };

  private readonly onDestroyed = (params: any) => {
    if (typeof params?.targetId === 'string') this.targetsById.delete(params.targetId);
  };

  constructor(
    private readonly session: CdpEventSessionLike,
    options: BrowserTargetControllerOptions = {},
  ) {
    this.navigationPolicy = options.navigationPolicy ?? {};
    this.protectAttachedTargets = options.protectAttachedTargets ?? true;
    session.on('Target.targetCreated', this.onCreated);
    session.on('Target.targetInfoChanged', this.onInfoChanged);
    session.on('Target.targetDestroyed', this.onDestroyed);
  }

  private upsert(raw: RawTargetInfo | undefined): void {
    if (!raw || typeof raw.targetId !== 'string' || typeof raw.type !== 'string') return;
    const existing = this.targetsById.get(raw.targetId);
    const target: BrowserTargetState = {
      targetId: raw.targetId,
      type: raw.type,
      attached: raw.attached === true,
      ...(typeof raw.openerId === 'string' ? { openerId: raw.openerId } : {}),
      sequence: existing?.sequence ?? ++this.sequence,
    };
    this.targetsById.set(target.targetId, target);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.session.send('Target.setDiscoverTargets', { discover: true });
    const result = await this.session.send('Target.getTargets') as { targetInfos?: RawTargetInfo[] };
    for (const info of result.targetInfos ?? []) this.upsert(info);
    this.started = true;
  }

  targets(): BrowserTargetState[] {
    return [...this.targetsById.values()]
      .sort((a, b) => a.sequence - b.sequence)
      .map(cloneTarget);
  }

  summary(): BrowserTargetSummary {
    const targets = this.targets();
    const pages = targets.filter((target) => target.type === 'page');
    const unattached = pages.filter((target) => !target.attached);
    return {
      total: targets.length,
      pages: pages.length,
      unattachedPages: unattached.length,
      ...(pages.length ? { latestPage: pages.at(-1) } : {}),
      ...(unattached.length ? { latestUnattachedPage: unattached.at(-1) } : {}),
    };
  }

  async createPage(url: string): Promise<CreateBrowserTargetResult> {
    const policyReason = navigationPolicyViolation(url, this.navigationPolicy);
    if (policyReason) return { status: 'policy-blocked', requestedUrl: url, policyReason };
    try {
      const result = await this.session.send('Target.createTarget', { url }) as { targetId?: string };
      if (!result.targetId) {
        return { status: 'protocol-error', requestedUrl: url, errorText: 'Target.createTarget returned no targetId' };
      }
      if (!this.targetsById.has(result.targetId)) {
        this.upsert({ targetId: result.targetId, type: 'page', attached: false });
      }
      return { status: 'created', requestedUrl: url, targetId: result.targetId };
    } catch (error) {
      return {
        status: 'protocol-error',
        requestedUrl: url,
        errorText: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async close(targetId: string, allowAttached = false): Promise<CloseBrowserTargetResult> {
    const target = this.targetsById.get(targetId);
    if (!target) return { status: 'not-found', targetId };
    if (this.protectAttachedTargets && target.attached && !allowAttached) {
      return { status: 'attached-target-blocked', targetId };
    }
    try {
      const result = await this.session.send('Target.closeTarget', { targetId }) as { success?: boolean };
      if (result.success === false) {
        return { status: 'protocol-error', targetId, errorText: 'Target.closeTarget returned success=false' };
      }
      this.targetsById.delete(targetId);
      return { status: 'closed', targetId };
    } catch (error) {
      return {
        status: 'protocol-error',
        targetId,
        errorText: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async closeLatestUnattachedPage(): Promise<CloseBrowserTargetResult | undefined> {
    const target = this.summary().latestUnattachedPage;
    return target ? this.close(target.targetId) : undefined;
  }

  dispose(): void {
    this.session.off?.('Target.targetCreated', this.onCreated);
    this.session.off?.('Target.targetInfoChanged', this.onInfoChanged);
    this.session.off?.('Target.targetDestroyed', this.onDestroyed);
    this.targetsById.clear();
  }
}
