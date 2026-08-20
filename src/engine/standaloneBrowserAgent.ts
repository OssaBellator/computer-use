import {
  CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE,
} from '../capabilities/standaloneChromiumCapabilities.js';
import {
  assessWebTaskCategory,
  type BrowserCapabilityProfile,
  type CapabilityAssessment,
  type WebTaskCategory,
} from '../capabilities/webTaskCapabilities.js';
import {
  launchStandaloneChromium,
  type StandaloneChromium,
  type StandaloneChromiumLaunchOptions,
} from '../runtime/standaloneChromium.js';
import {
  MultiPageCdpAgent,
  type MultiPageSwitchResult,
} from './multiPageCdpAgent.js';
import {
  MultiPageTaskEngine,
} from './multiPageTaskEngine.js';
import type {
  CdpBrowserAgentEngine,
  CdpBrowserAgentEngineOptions,
} from './cdpBrowserAgentEngine.js';

export interface StandaloneBrowserAgentLaunchOptions {
  chromium?: StandaloneChromiumLaunchOptions;
  /** Per-page semantic/browser controller configuration. */
  page?: CdpBrowserAgentEngineOptions;
  /** Select and prepare the initial page automatically. Defaults to true. */
  selectInitialPage?: boolean;
}

/**
 * Fully self-hosted browser-agent runtime: Node launches Chromium, speaks raw
 * remote-debugging-pipe CDP, routes target sessions, and builds the repo's
 * semantic multi-page/task engine without Playwright/Puppeteer/WebDriver.
 */
export class StandaloneBrowserAgent {
  readonly pages: MultiPageCdpAgent;
  readonly taskEngine: MultiPageTaskEngine;
  readonly capabilityProfile: BrowserCapabilityProfile =
    CURRENT_STANDALONE_CHROMIUM_CAPABILITY_PROFILE;
  private shutdownPromise?: Promise<void>;

  constructor(
    readonly chromium: StandaloneChromium,
    pageOptions: CdpBrowserAgentEngineOptions = {},
  ) {
    this.pages = new MultiPageCdpAgent(chromium.router, pageOptions);
    this.taskEngine = new MultiPageTaskEngine(this.pages);
  }

  get activeEngine(): CdpBrowserAgentEngine | undefined {
    return this.pages.activeEngine;
  }

  assessCategory(category: WebTaskCategory): CapabilityAssessment {
    return assessWebTaskCategory(this.capabilityProfile, category);
  }

  async prepare(selectInitialPage = true): Promise<MultiPageSwitchResult | undefined> {
    await this.pages.start();
    if (!selectInitialPage || this.pages.activeEngine) return undefined;

    const existing = await this.pages.switchToLatestPage();
    if (existing.status === 'switched') return existing;
    if (existing.status !== 'target-not-found') {
      throw new Error(`Failed to select initial Chromium page: ${existing.status}`);
    }

    const created = await this.pages.createAndSwitch('about:blank');
    if (created.status !== 'switched') {
      throw new Error(`Failed to create initial Chromium page: ${created.status}`);
    }
    return {
      status: 'switched',
      ...(created.targetId ? { targetId: created.targetId } : {}),
      ...(created.reused !== undefined ? { reused: created.reused } : {}),
    };
  }

  shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = this.shutdownInternal();
    return this.shutdownPromise;
  }

  private async shutdownInternal(): Promise<void> {
    await this.pages.shutdown().catch(() => {});
    await this.chromium.shutdown();
  }
}

export async function launchStandaloneBrowserAgent(
  options: StandaloneBrowserAgentLaunchOptions = {},
): Promise<StandaloneBrowserAgent> {
  const chromium = await launchStandaloneChromium(options.chromium);
  const agent = new StandaloneBrowserAgent(chromium, options.page);
  try {
    await agent.prepare(options.selectInitialPage ?? true);
    return agent;
  } catch (error) {
    await agent.shutdown().catch(() => {});
    throw error;
  }
}
