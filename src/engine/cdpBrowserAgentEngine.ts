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
  CdpFileUploadController,
  type BrowserFileUploadControllerOptions,
  type BrowserFileUploadResult,
} from '../browser/fileUploadController.js';
import {
  CdpHistoryController,
  type BrowserHistoryAction,
  type BrowserHistoryController,
  type BrowserHistoryOptions,
  type BrowserHistoryResult,
} from '../browser/historyController.js';
import {
  CdpNavigationGuard,
} from '../browser/navigationGuard.js';
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
import type { TargetQuery, TargetResolution } from '../model/targetResolver.js';
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
    readonly uploads?: CdpFileUploadController,
    readonly navigationGuard?: CdpNavigationGuard,
  ) {}

  async prepare(): Promise<void> {
    await Promise.all([
      this.dialogs?.start(),
      this.targets?.start(),
      this.downloads?.start(),
      this.uploads?.start(),
      this.navigationGuard?.start(),
    ]);
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

  async uploadFiles(
    query: TargetQuery | string,
    paths: readonly string[],
    options: { requireUnambiguous?: boolean } = {},
  ): Promise<BrowserFileUploadResult> {
    const unresolved = { targetId: '', fileCount: paths.length, totalBytes: 0 };
    if (!this.uploads) {
      return {
        ...unresolved,
        status: 'configuration-error',
        errorText: 'File upload is not configured for this browser-agent engine',
      };
    }

    let resolution: TargetResolution;
    try {
      resolution = await this.interaction.resolveDetailed(query);
    } catch {
      return { ...unresolved, status: 'invalid-target' };
    }
    if (!resolution.target || ((options.requireUnambiguous ?? true) && resolution.ambiguous)) {
      return { ...unresolved, status: 'invalid-target' };
    }
    return this.uploads.upload(resolution.target, paths);
  }

  navigate(url: string, options?: BrowserNavigationOptions): Promise<BrowserNavigationResult> {
    return this.navigator.navigate(url, options);
  }

  history(action: BrowserHistoryAction, options?: BrowserHistoryOptions): Promise<BrowserHistoryResult> {
    switch (action) {
      case 'back': return this.goBack(options);
      case 'forward': return this.goForward(options);
      case 'reload': return this.reload(options);
    }
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
  /**
   * Intercept page-initiated Document requests with Fetch and apply navigationPolicy
   * before network dispatch. Defaults to true when navigationPolicy is supplied.
   */
  enforceNavigationPolicyAtRequestBoundary?: boolean;
  /** Explicit opt-in; download files are stored under opaque CDP GUID names. */
  downloadOptions?: BrowserDownloadControllerOptions;
  /** Explicit opt-in local-file disclosure policy for file inputs. */
  uploadOptions?: BrowserFileUploadControllerOptions;
}

export function createCdpBrowserAgentEngine(
  page: SnapshotPageLike,
  session: CdpSessionLike,
  options: CdpBrowserAgentEngineOptions = {},
): CdpBrowserAgentEngine {
  const {
    navigationPolicy,
    enforceNavigationPolicyAtRequestBoundary,
    downloadOptions,
    uploadOptions,
    ...interactionOptions
  } = options;
  const eventSession = isCdpEventSessionLike(session) ? session : undefined;
  const useNavigationGuard = eventSession !== undefined &&
    (enforceNavigationPolicyAtRequestBoundary ?? navigationPolicy !== undefined);
  return new CdpBrowserAgentEngine(
    createCdpInteractionEngine(page, session, interactionOptions),
    session,
    new CdpNavigationController(session, navigationPolicy),
    eventSession ? new CdpDialogController(eventSession) : undefined,
    eventSession ? new CdpTargetController(eventSession, { navigationPolicy }) : undefined,
    eventSession && downloadOptions ? new CdpDownloadController(eventSession, downloadOptions) : undefined,
    new CdpHistoryController(session, navigationPolicy),
    uploadOptions ? new CdpFileUploadController(session, uploadOptions) : undefined,
    useNavigationGuard ? new CdpNavigationGuard(eventSession, navigationPolicy) : undefined,
  );
}
