import type { BrowserDialogHandleResult, BrowserDialogState } from '../browser/dialogController.js';
import type { BrowserDownloadSummary } from '../browser/downloadController.js';
import type { BrowserFileUploadResult } from '../browser/fileUploadController.js';
import type { BrowserHistoryAction, BrowserHistoryOptions, BrowserHistoryResult } from '../browser/historyController.js';
import type { BrowserNavigationOptions, BrowserNavigationResult } from '../browser/navigationController.js';
import type { BrowserTargetSummary, CloseBrowserTargetResult, CreateBrowserTargetResult } from '../browser/targetController.js';
import type { TargetQuery } from '../model/targetResolver.js';
import type { InteractionNode } from '../types.js';
import type { TaskPageSelection } from '../agent/taskProgram.js';
import type {
  TaskEngineActionResult,
  TaskKeyActionResult,
  TaskPageSwitchResult,
  TaskRuntimeEngine,
} from '../agent/taskRuntime.js';
import { MultiPageCdpAgent } from './multiPageCdpAgent.js';

interface SemanticActivateOptions {
  requireUnambiguous?: boolean;
  autoReveal?: boolean;
  method?: 'auto' | 'keyboard' | 'pointer';
  key?: string;
}

interface SemanticTypeOptions {
  requireUnambiguous?: boolean;
  autoReveal?: boolean;
  delayMs?: number;
  expectedValue?: string;
}

interface PressKeyOptions {
  timeoutMs?: number;
  maxSamples?: number;
  pollIntervalMs?: number;
}

/**
 * TaskRuntimeEngine adapter over MultiPageCdpAgent. With no active page, passive
 * observation stays available through root target topology while semantic page
 * nodes/browser state are empty until a static switch-page action succeeds.
 */
export class MultiPageTaskEngine implements TaskRuntimeEngine {
  constructor(readonly pages: MultiPageCdpAgent) {}

  async prepare(): Promise<void> {
    await this.pages.start();
  }

  async refresh(): Promise<InteractionNode[]> {
    return this.pages.activeEngine ? this.pages.activeEngine.refresh() : [];
  }

  async browserState() {
    return this.pages.activeEngine?.browserState();
  }

  dialogState(): BrowserDialogState | undefined {
    return this.pages.activeEngine?.dialogState();
  }

  targetState(): BrowserTargetSummary {
    return this.pages.targets.summary();
  }

  downloadState(): BrowserDownloadSummary | undefined {
    return this.pages.activeEngine?.downloadState();
  }

  activate(
    query: TargetQuery | string,
    options?: SemanticActivateOptions,
  ): Promise<TaskEngineActionResult> {
    return this.pages.activeEngine?.activate(query, options) ??
      Promise.resolve({ status: 'target-not-found', target: null });
  }

  typeInto(
    query: TargetQuery | string,
    text: string,
    options?: SemanticTypeOptions,
  ): Promise<TaskEngineActionResult> {
    return this.pages.activeEngine?.typeInto(query, text, options) ??
      Promise.resolve({ status: 'target-not-found', target: null });
  }

  pressKey(key: string, options?: PressKeyOptions): Promise<TaskKeyActionResult> {
    return this.pages.activeEngine?.pressKey(key, options) ??
      Promise.resolve({ status: 'unverified' });
  }

  uploadFiles(
    query: TargetQuery | string,
    paths: readonly string[],
    options?: { requireUnambiguous?: boolean },
  ): Promise<BrowserFileUploadResult> {
    return this.pages.activeEngine?.uploadFiles(query, paths, options) ?? Promise.resolve({
      status: 'invalid-target', targetId: '', fileCount: paths.length, totalBytes: 0,
    });
  }

  navigate(url: string, options?: BrowserNavigationOptions): Promise<BrowserNavigationResult> {
    return this.pages.activeEngine?.navigate(url, options) ?? Promise.resolve({
      status: 'navigation-error', requestedUrl: url,
      errorText: 'No active page is selected', polls: 0,
    });
  }

  history(action: BrowserHistoryAction, options?: BrowserHistoryOptions): Promise<BrowserHistoryResult> {
    return this.pages.activeEngine?.history(action, options) ?? Promise.resolve({
      status: 'navigation-error', action,
      errorText: 'No active page is selected', polls: 0,
    });
  }

  handleDialog(accept: boolean, promptText?: string): Promise<BrowserDialogHandleResult> {
    return this.pages.activeEngine?.handleDialog(accept, promptText) ?? Promise.resolve({
      status: 'no-dialog', accepted: accept,
    });
  }

  createPageTarget(url: string): Promise<CreateBrowserTargetResult> {
    return this.pages.targets.createPage(url);
  }

  closeLatestUnattachedPage(): Promise<CloseBrowserTargetResult | undefined> {
    return this.pages.targets.closeLatestUnattachedPage();
  }

  async switchPage(target: TaskPageSelection): Promise<TaskPageSwitchResult> {
    const result = target === 'latest-page'
      ? await this.pages.switchToLatestPage()
      : await this.pages.switchToLatestUnattachedPage();
    return { status: result.status, ...(result.targetId ? { targetId: result.targetId } : {}) };
  }
}
