import type { BrowserStateSnapshot } from '../browser/browserState.js';
import type { BrowserDialogHandleResult, BrowserDialogState } from '../browser/dialogController.js';
import type { BrowserDownloadSummary } from '../browser/downloadController.js';
import type { BrowserFileUploadResult } from '../browser/fileUploadController.js';
import type {
  BrowserHistoryAction,
  BrowserHistoryOptions,
  BrowserHistoryResult,
} from '../browser/historyController.js';
import type { BrowserNavigationOptions, BrowserNavigationResult } from '../browser/navigationController.js';
import type {
  BrowserTargetSummary,
  CloseBrowserTargetResult,
  CreateBrowserTargetResult,
} from '../browser/targetController.js';
import type { TargetQuery } from '../model/targetResolver.js';
import type { InteractionNode } from '../types.js';
import type { TaskPageSelection, TaskRisk, TaskStep } from './taskProgram.js';

export interface TaskEngineActionResult {
  status: string;
  target: InteractionNode | null;
}

export interface TaskPageSwitchResult {
  status: string;
  targetId?: string;
}

/** Minimal structural contract implemented by InteractionEngine-compatible facades. */
export interface TaskRuntimeEngine {
  prepare?(): Promise<void>;
  refresh(): Promise<InteractionNode[]>;
  browserState?(): Promise<BrowserStateSnapshot | undefined>;
  dialogState?(): BrowserDialogState | undefined;
  targetState?(): BrowserTargetSummary | undefined;
  downloadState?(): BrowserDownloadSummary | undefined;
  activate(
    query: TargetQuery | string,
    options?: {
      requireUnambiguous?: boolean;
      autoReveal?: boolean;
      method?: 'auto' | 'keyboard' | 'pointer';
      key?: string;
    },
  ): Promise<TaskEngineActionResult>;
  typeInto(
    query: TargetQuery | string,
    text: string,
    options?: {
      requireUnambiguous?: boolean;
      autoReveal?: boolean;
      delayMs?: number;
      expectedValue?: string;
    },
  ): Promise<TaskEngineActionResult>;
  uploadFiles?(
    query: TargetQuery | string,
    paths: readonly string[],
    options?: { requireUnambiguous?: boolean },
  ): Promise<BrowserFileUploadResult>;
  switchPage?(target: TaskPageSelection): Promise<TaskPageSwitchResult>;
  navigate?(url: string, options?: BrowserNavigationOptions): Promise<BrowserNavigationResult>;
  history?(action: BrowserHistoryAction, options?: BrowserHistoryOptions): Promise<BrowserHistoryResult>;
  handleDialog?(accept: boolean, promptText?: string): Promise<BrowserDialogHandleResult>;
  createPageTarget?(url: string): Promise<CreateBrowserTargetResult>;
  closeLatestUnattachedPage?(): Promise<CloseBrowserTargetResult | undefined>;
}

export type TaskRunStatus =
  | 'completed'
  | 'failed'
  | 'invalid-program'
  | 'missing-input'
  | 'budget-exhausted'
  | 'loop-detected'
  | 'stalled'
  | 'policy-blocked';

export type TaskTraceOutcome =
  | 'verified'
  | 'uploaded'
  | 'page-switched'
  | 'navigated'
  | 'history-navigated'
  | 'dialog-handled'
  | 'target-created'
  | 'target-closed'
  | 'failed'
  | 'exception'
  | 'asserted'
  | 'assertion-failed'
  | 'branch-then'
  | 'branch-else'
  | 'wait-satisfied'
  | 'wait-timeout'
  | 'completed'
  | 'completion-condition-failed'
  | 'policy-blocked';

export interface TaskTraceEntry {
  index: number;
  stepId: string;
  kind: TaskStep['kind'];
  outcome: TaskTraceOutcome;
  nextStepId?: string;
  targetId?: string;
  actionStatus?: string;
  beforeFingerprint: string;
  afterFingerprint: string;
  browserStateChanged: boolean;
  visit: number;
}

export interface TaskApprovalContext {
  programName?: string;
  stepId: string;
  kind: 'activate' | 'type' | 'upload' | 'switch-page' | 'navigate' | 'history' |
    'handle-dialog' | 'open-tab' | 'close-latest-tab';
  risk: Exclude<TaskRisk, 'observe'>;
  visit: number;
}

export interface TaskRuntimeOptions {
  maxSteps?: number;
  maxVisitsPerStep?: number;
  maxConsecutiveNoProgress?: number;
  requireUnambiguousTargets?: boolean;
  /** external-side-effect is blocked by default unless explicitly allowed or approved. */
  maxRisk?: TaskRisk;
  approve?: (context: TaskApprovalContext) => boolean | Promise<boolean>;
  onTrace?: (entry: TaskTraceEntry) => void | Promise<void>;
  waitPollIntervalMs?: number;
  waitMaxPolls?: number;
}

export interface TaskRunResult {
  status: TaskRunStatus;
  completed: boolean;
  finalStepId?: string;
  stepsExecuted: number;
  trace: TaskTraceEntry[];
  validationErrors?: string[];
  validationWarnings?: string[];
  missingInputs?: string[];
}
