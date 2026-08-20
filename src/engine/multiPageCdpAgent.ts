import { CdpTargetController, type CloseBrowserTargetResult } from '../browser/targetController.js';
import {
  CdpTargetSessionRouter,
  type RoutedCdpSession,
} from '../browser/cdpSessionRouter.js';
import {
  createPureCdpBrowserAgentEngine,
} from './pureCdpEngine.js';
import type {
  CdpBrowserAgentEngine,
  CdpBrowserAgentEngineOptions,
} from './cdpBrowserAgentEngine.js';

export type MultiPageSwitchStatus =
  | 'switched'
  | 'target-not-found'
  | 'not-page'
  | 'attach-failed'
  | 'activate-failed';

export interface MultiPageSwitchResult {
  status: MultiPageSwitchStatus;
  targetId?: string;
  reused?: boolean;
}

export type MultiPageCreateSwitchStatus =
  | MultiPageSwitchStatus
  | 'policy-blocked'
  | 'create-failed';

export interface MultiPageCreateSwitchResult {
  status: MultiPageCreateSwitchStatus;
  targetId?: string;
  reused?: boolean;
}

export interface MultiPageCdpAgentSummary {
  knownPages: number;
  attachedPages: number;
  activeTargetId?: string;
  latestPageTargetId?: string;
  latestUnattachedPageTargetId?: string;
}

interface AttachedPageAgent {
  session: RoutedCdpSession;
  engine: CdpBrowserAgentEngine;
}

export type MultiPageEngineFactory = (
  session: RoutedCdpSession,
  options: CdpBrowserAgentEngineOptions,
) => Promise<CdpBrowserAgentEngine>;

/**
 * Multi-tab semantic browser controller built on browser-root CDP routing.
 * Target state retains IDs/type/sequence only; URL/title text remains inside the
 * active per-page engine rather than becoming cross-tab controller state.
 */
export class MultiPageCdpAgent {
  readonly targets: CdpTargetController;
  private readonly attached = new Map<string, AttachedPageAgent>();
  private started = false;
  private activeTarget?: string;

  constructor(
    readonly router: CdpTargetSessionRouter,
    readonly pageOptions: CdpBrowserAgentEngineOptions = {},
    targets?: CdpTargetController,
    private readonly createEngine: MultiPageEngineFactory = createPureCdpBrowserAgentEngine,
  ) {
    this.targets = targets ?? new CdpTargetController(router.root, {
      navigationPolicy: pageOptions.navigationPolicy,
      protectAttachedTargets: true,
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.targets.start();
    this.started = true;
  }

  summary(): MultiPageCdpAgentSummary {
    const targetSummary = this.targets.summary();
    return {
      knownPages: targetSummary.pages,
      attachedPages: this.attached.size,
      ...(this.activeTarget ? { activeTargetId: this.activeTarget } : {}),
      ...(targetSummary.latestPage
        ? { latestPageTargetId: targetSummary.latestPage.targetId }
        : {}),
      ...(targetSummary.latestUnattachedPage
        ? { latestUnattachedPageTargetId: targetSummary.latestUnattachedPage.targetId }
        : {}),
    };
  }

  get activeEngine(): CdpBrowserAgentEngine | undefined {
    return this.activeTarget ? this.attached.get(this.activeTarget)?.engine : undefined;
  }

  engineFor(targetId: string): CdpBrowserAgentEngine | undefined {
    return this.attached.get(targetId)?.engine;
  }

  async switchTo(targetId: string): Promise<MultiPageSwitchResult> {
    await this.start();
    const target = this.targets.targets().find((candidate) => candidate.targetId === targetId);
    if (!target) return { status: 'target-not-found', targetId };
    if (target.type !== 'page') return { status: 'not-page', targetId };

    let binding = this.attached.get(targetId);
    const reused = binding !== undefined;
    if (!binding) {
      let session: RoutedCdpSession | undefined;
      try {
        session = await this.router.attach(targetId);
        const engine = await this.createEngine(session, this.pageOptions);
        await engine.prepare();
        binding = { session, engine };
        this.attached.set(targetId, binding);
      } catch {
        if (session) await this.router.detach(session).catch(() => {});
        return { status: 'attach-failed', targetId, reused: false };
      }
    }

    try {
      await this.router.activate(targetId);
    } catch {
      return { status: 'activate-failed', targetId, reused };
    }
    this.activeTarget = targetId;
    return { status: 'switched', targetId, reused };
  }

  async switchToLatestPage(): Promise<MultiPageSwitchResult> {
    await this.start();
    const target = this.targets.summary().latestPage;
    return target
      ? this.switchTo(target.targetId)
      : { status: 'target-not-found' };
  }

  async switchToLatestUnattachedPage(): Promise<MultiPageSwitchResult> {
    await this.start();
    const target = this.targets.summary().latestUnattachedPage;
    return target
      ? this.switchTo(target.targetId)
      : { status: 'target-not-found' };
  }

  async createAndSwitch(url: string): Promise<MultiPageCreateSwitchResult> {
    await this.start();
    const created = await this.targets.createPage(url);
    if (created.status === 'policy-blocked') return { status: 'policy-blocked' };
    if (created.status !== 'created' || !created.targetId) return { status: 'create-failed' };
    return this.switchTo(created.targetId);
  }

  async detachPage(targetId: string): Promise<boolean> {
    const binding = this.attached.get(targetId);
    if (!binding) return false;
    await this.router.detach(binding.session);
    this.attached.delete(targetId);
    if (this.activeTarget === targetId) this.activeTarget = undefined;
    return true;
  }

  async closePage(targetId: string): Promise<CloseBrowserTargetResult> {
    const binding = this.attached.get(targetId);
    if (binding) {
      await this.router.detach(binding.session).catch(() => {});
      this.attached.delete(targetId);
    }
    if (this.activeTarget === targetId) this.activeTarget = undefined;
    return this.targets.close(targetId, true);
  }

  async shutdown(): Promise<void> {
    const bindings = [...this.attached.values()];
    this.attached.clear();
    this.activeTarget = undefined;
    await Promise.all(bindings.map((binding) => this.router.detach(binding.session).catch(() => {})));
    this.targets.dispose();
    this.started = false;
  }
}
