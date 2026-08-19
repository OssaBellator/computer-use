import { captureCdpBrowserState, type BrowserStateSnapshot } from '../browser/browserState.js';
import type { CdpSessionLike } from '../browser/cdpIdentity.js';
import {
  CdpDownloadController,
  type BrowserDownloadControllerOptions,
  type BrowserDownloadSummary,
} from '../browser/downloadController.js';
import {
  CdpDialogController,
  isCdpEventSessionLike,
  type BrowserDialogController,
  type BrowserDialogHandleResult,
  type BrowserDialogState,
} from '../browser/dialogController.js';
import {
  CdpHistoryController,
  type BrowserHistoryController,
  type BrowserHistoryOptions,
  type BrowserHistoryResult,
} from '../browser/historyController.js';
import {
  CdpNavigationController,
  type BrowserNavigationOptions,
  type BrowserNavigationResult,
  type BrowserNavigator,
  type NavigationPolicy,
} from '../browser/navigationController.js';
import type { SnapshotPageLike } from '../browser/domSnapshot.js';
import {
  CdpTargetController,
  type BrowserTargetSummary,
  type CloseBrowserTargetResult,
  type CreateBrowserTargetResult,
} from '../browser/targetController.js';
import type { TargetQuery } from '../model/targetResolver.js';
import type { InteractionNode } from '../types.js';
import type { TaskRuntimeEngine, TaskEngineActionResult } from '../agent/taskRuntime.js';
import {
  createCdpInteractionEngine,
  type CdpInteractionEngineOptions,
} from './cdpInteractionEngine.js';
import type { InteractionEngine } from './interactionEngine.js';

/**
 * Task-runtime facade that composes the existing semantic interaction engine
 * with browser-level state and navigation primitives from the same CDP session.
 */
export class CdpBrowserAgentEngine implements TaskRuntimeEngine {
  constructor(
    readonly interaction: InteractionEngine,
    private readonly session: CdpSessionLike,
    readonly navigator: BrowserNavigator = new CdpNavigationController(session),
    readonly dialogs?: BrowserDialogController,
    readonly targets?: CdpTargetController,
    readonly downloads?: CdpDownloadController,
    readonly historyController: BrowserHistoryController = new CdpHistoryController(session),
  ) {}

  async prepare(): Promise<void> {
    await Promise.all([this.dialogs?.start(), this.targets?.start(), this.downloads?.start()]);
  }

  refresh(): Promise<InteractionNode[]> {
    return this.interaction.refresh();
  }

  browserState(): Promise<BrowserStateSnapshot> {
    return captureCdpBrowserState(this.session);
  }

  dialogState(): BrowserDialogState | undefined {
    return this.dialogs?.state();
  }

  targetState(): BrowserTargetSummary | undefined {
    return this.targets?.summary();
  }

  downloadState(): BrowserDownloadSummary | undefined {
    return this.downloads?.summary();
  }

  activate(
    query: TargetQuery | string,
    options?: Parameters<InteractionEngine['activate']>[1],
  ): Promise<TaskEngineActionResult> {
    return this.interaction.activate(query, options);
  }

  typeInto(
    query: TargetQuery | string,
    text: string,
    options?: Parameters<InteractionEngine['typeInto']>[2],
  ): Promise<TaskEngineActionResult> {
    return this.interaction.typeInto(query, text, options);
  }

  navigate(url: string, options?: BrowserNavigationOptions): Promise<BrowserNavigationResult> {
    return this.navigator.navigate(url, options);
  }

  goBack(options?: BrowserHistoryOptions): Promise<BrowserHistoryResult> {
    return this.historyController.back(options);
  }

  goForward(options?: BrowserHistoryOptions): Promise<BrowserHistoryResult> {
    return this.historyController.forward(options);
  }

  reload(options?: BrowserHistoryOptions): Promise<BrowserHistoryResult> {
    return this.historyController.reload(options);
  }

  createPageTarget(url: string): Promise<CreateBrowserTargetResult> {
    if (!this.targets) {
      return Promise.resolve({
        status: 'protocol-error',
        requestedUrl: url,
        errorText: 'CDP session does not expose event subscriptions for target lifecycle monitoring',
      });
    }
    return this.targets.createPage(url);
  }

  closeLatestUnattachedPage(): Promise<CloseBrowserTargetResult | undefined> {
    return this.targets?.closeLatestUnattachedPage() ?? Promise.resolve(undefined);
  }

  handleDialog(accept: boolean, promptText?: string): Promise<BrowserDialogHandleResult> {
    if (!this.dialogs) {
      return Promise.resolve({
        status: 'protocol-error',
        accepted: accept,
        errorText: 'CDP session does not expose event subscriptions for dialog monitoring',
      });
    }
    return this.dialogs.handle(accept, promptText);
  }
}

export interface CdpBrowserAgentEngineOptions extends CdpInteractionEngineOptions {
  navigationPolicy?: NavigationPolicy;
  /** Explicit opt-in; download files are stored under opaque CDP GUID names. */
  downloadOptions?: BrowserDownloadControllerOptions;
}

export function createCdpBrowserAgentEngine(
  page: SnapshotPageLike,
  session: CdpSessionLike,
  options: CdpBrowserAgentEngineOptions = {},
): CdpBrowserAgentEngine {
  const { navigationPolicy, downloadOptions, ...interactionOptions } = options;
  const eventSession = isCdpEventSessionLike(session) ? session : undefined;
  return new CdpBrowserAgentEngine(
    createCdpInteractionEngine(page, session, interactionOptions),
    session,
    new CdpNavigationController(session, navigationPolicy),
    eventSession ? new CdpDialogController(eventSession) : undefined,
    eventSession ? new CdpTargetController(eventSession, { navigationPolicy }) : undefined,
    eventSession && downloadOptions ? new CdpDownloadController(eventSession, downloadOptions) : undefined,
    new CdpHistoryController(session, navigationPolicy),
  );
}
