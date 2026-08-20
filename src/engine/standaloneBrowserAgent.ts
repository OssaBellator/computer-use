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

  async prepare(selectInitialPage = true): Promise<MultiPageSwitchResult | undefined> {
    await this.pages.start();
    if (!selectInitialPage || this.pages.activeEngine) return undefined;

    let result = await this.pages.switchToLatestPage();
    if (result.status === 'target-not-found') {
      result = await this.pages.createAndSwitch('about:blank');
    }
    if (result.status !== 'switched') {
      throw new Error(`Failed to select initial Chromium page: ${result.status}`);
    }
    return result;
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
