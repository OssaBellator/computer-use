import type { TaskRuntimeEngine, TaskEngineActionResult, TaskKeyActionResult } from '../agent/taskRuntime.js';
import { captureCdpBrowserState, type BrowserStateSnapshot } from '../browser/browserState.js';
import type { CdpSessionLike } from '../browser/cdpIdentity.js';
import type { DocumentContentOptions, DocumentContentSnapshot } from '../browser/documentContent.js';
import { DocumentFormattingObserver } from '../browser/documentFormatting.js';
import { DocumentSelectionObserver } from '../browser/documentSelection.js';
import { CdpDownloadController, type BrowserDownloadControllerOptions, type BrowserDownloadSummary } from '../browser/downloadController.js';
import { CdpDialogController, isCdpEventSessionLike, type BrowserDialogController, type BrowserDialogHandleResult, type BrowserDialogState } from '../browser/dialogController.js';
import type { SnapshotPageLike } from '../browser/domSnapshot.js';
import { CdpFileUploadController, type BrowserFileUploadControllerOptions, type BrowserFileUploadResult } from '../browser/fileUploadController.js';
import { CdpHistoryController, type BrowserHistoryAction, type BrowserHistoryController, type BrowserHistoryOptions, type BrowserHistoryResult } from '../browser/historyController.js';
import { CdpNavigationGuard } from '../browser/navigationGuard.js';
import { CdpNavigationController, type BrowserNavigationOptions, type BrowserNavigationResult, type BrowserNavigator, type NavigationPolicy } from '../browser/navigationController.js';
import { CdpNetworkActivityMonitor, type NetworkIdleOptions, type NetworkIdleResult } from '../browser/networkActivityMonitor.js';
import { observeMediaState, type MediaStateSnapshot, type ObserveMediaStateOptions } from '../browser/mediaState.js';
import { CdpSelectController, type BrowserSelectMatch, type BrowserSelectResult } from '../browser/selectController.js';
import { CdpTargetController, type BrowserTargetSummary, type CloseBrowserTargetResult, type CreateBrowserTargetResult } from '../browser/targetController.js';
import { CdpVisualObserver, type VisualCaptureOptions, type VisualSnapshot } from '../browser/visualObserver.js';
import { RichTextController } from '../controller/richTextController.js';
import type { TargetQuery, TargetResolution } from '../model/targetResolver.js';
import type { InteractionNode } from '../types.js';
import { createCdpInteractionEngine, type CdpInteractionEngineOptions } from './cdpInteractionEngine.js';
import type { InteractionEngine } from './interactionEngine.js';

const MAX_FRAME_DOCUMENT_TOKEN_FRAMES = 32;
const MAX_FRAME_DOCUMENT_TOKEN_BYTES = 4 * 1024;
const FRAME_DOCUMENT_TOKENS_INCOMPLETE = '__browser_identity_incomplete__';

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
    readonly networkActivity?: CdpNetworkActivityMonitor,
    readonly selects: CdpSelectController = new CdpSelectController(session),
    readonly richText?: RichTextController,
    private readonly snapshotPage?: SnapshotPageLike,
  ) {}

  async prepare(): Promise<void> {
    await Promise.all([
      this.dialogs?.start(),
      this.targets?.start(),
      this.downloads?.start(),
      this.uploads?.start(),
      this.navigationGuard?.start(),
      this.networkActivity?.start(),
    ]);
  }

  refresh(): Promise<InteractionNode[]> {
    return this.interaction.refresh();
  }

  browserState(): Promise<BrowserStateSnapshot> {
    return captureCdpBrowserState(this.session);
  }

  async frameDocumentTokens(): Promise<Readonly<Record<string, string>> | undefined> {
    if (!this.snapshotPage) return undefined;
    const frames = this.snapshotPage.frames();
    const boundedFrames = frames.slice(0, MAX_FRAME_DOCUMENT_TOKEN_FRAMES);
    const entries = await Promise.all(boundedFrames.map(async (frame, index) => {
      const timeOrigin = await frame.evaluate(() => performance.timeOrigin);
      if (!Number.isFinite(timeOrigin) || timeOrigin < 0) return undefined;
      return [index === 0 ? 'main' : `frame-${index}`, timeOrigin.toString(36)] as const;
    }));
    const result: Record<string, string> = {};
    let bytes = 0;
    let complete = frames.length <= MAX_FRAME_DOCUMENT_TOKEN_FRAMES;
    for (const entry of entries) {
      if (!entry) { complete = false; continue; }
      const [frameId, token] = entry;
      const entryBytes = Buffer.byteLength(frameId) + Buffer.byteLength(token);
      if (bytes + entryBytes > MAX_FRAME_DOCUMENT_TOKEN_BYTES) { complete = false; break; }
      bytes += entryBytes;
      result[frameId] = token;
    }
    if (!complete) result[FRAME_DOCUMENT_TOKENS_INCOMPLETE] = '1';
    return result;
  }

  documentContent(options?: DocumentContentOptions): Promise<DocumentContentSnapshot | undefined> {
    return this.interaction.observer.documentContent?.(options) ?? Promise.resolve(undefined);
  }

  visualSnapshot(options?: VisualCaptureOptions): Promise<VisualSnapshot> {
    return new CdpVisualObserver(this.session).capture(options);
  }

  mediaSnapshot(options?: ObserveMediaStateOptions): Promise<MediaStateSnapshot> {
    return observeMediaState(this.session, options);
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

  hover(
    query: TargetQuery | string,
    options?: Parameters<InteractionEngine['hover']>[1],
  ): Promise<TaskEngineActionResult> {
    return this.interaction.hover(query, options);
  }

  typeInto(
    query: TargetQuery | string,
    text: string,
    options?: Parameters<InteractionEngine['typeInto']>[2],
  ): Promise<TaskEngineActionResult> {
    return this.interaction.typeInto(query, text, options);
  }

  pressKey(
    key: string,
    options?: Parameters<InteractionEngine['pressKey']>[1],
  ): Promise<TaskKeyActionResult> {
    return this.interaction.pressKey(key, options);
  }

  scrollViewport(
    delta: Parameters<InteractionEngine['scrollViewport']>[0],
    options?: Parameters<InteractionEngine['scrollViewport']>[1],
  ): Promise<TaskKeyActionResult> {
    return this.interaction.scrollViewport(delta, options);
  }

  waitForNetworkIdle(options?: NetworkIdleOptions): Promise<NetworkIdleResult> {
    return this.networkActivity?.waitForIdle(options) ?? Promise.resolve({
      idle: false,
      summary: { inFlight: 0, started: 0, finished: 0, failed: 0, activitySequence: 0 },
      elapsedMs: 0,
      samples: 0,
    });
  }

  async selectOption(
    query: TargetQuery | string,
    option: string,
    options: { requireUnambiguous?: boolean; by?: BrowserSelectMatch } = {},
  ): Promise<BrowserSelectResult> {
    let resolution: TargetResolution;
    try {
      resolution = await this.interaction.resolveDetailed(query);
    } catch {
      return { status: 'invalid-target', target: null };
    }
    if (!resolution.target || ((options.requireUnambiguous ?? true) && resolution.ambiguous)) {
      return { status: 'invalid-target', target: resolution.target };
    }
    return this.selects.select(resolution.target, option, { by: options.by });
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
  enforceNavigationPolicyAtRequestBoundary?: boolean;
  downloadOptions?: BrowserDownloadControllerOptions;
  uploadOptions?: BrowserFileUploadControllerOptions;
  /** Explicit opt-in URL-redacted network lifecycle monitoring. */
  networkActivity?: boolean;
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
    networkActivity,
    ...interactionOptions
  } = options;
  const eventSession = isCdpEventSessionLike(session) ? session : undefined;
  const useNavigationGuard = eventSession !== undefined &&
    (enforceNavigationPolicyAtRequestBoundary ?? navigationPolicy !== undefined);
  const interaction = createCdpInteractionEngine(page, session, interactionOptions);
  const richText = new RichTextController(
    interaction.input,
    new DocumentSelectionObserver(page),
    new DocumentFormattingObserver(page),
  );
  return new CdpBrowserAgentEngine(
    interaction,
    session,
    new CdpNavigationController(session, navigationPolicy),
    eventSession ? new CdpDialogController(eventSession) : undefined,
    eventSession ? new CdpTargetController(eventSession, { navigationPolicy }) : undefined,
    eventSession && downloadOptions ? new CdpDownloadController(eventSession, downloadOptions) : undefined,
    new CdpHistoryController(session, navigationPolicy),
    uploadOptions ? new CdpFileUploadController(session, uploadOptions) : undefined,
    useNavigationGuard ? new CdpNavigationGuard(eventSession, navigationPolicy) : undefined,
    eventSession && networkActivity === true ? new CdpNetworkActivityMonitor(eventSession) : undefined,
    new CdpSelectController(session),
    richText,
    page,
  );
}
