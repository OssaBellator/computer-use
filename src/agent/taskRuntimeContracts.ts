import type { BrowserStateSnapshot } from '../browser/browserState.js';
import type {
  BrowserCommitmentConfidence,
  BrowserCommitmentKind,
  BrowserCommitmentStatus,
  BrowserCommitmentSummary,
} from '../browser/commitmentDetector.js';
import type { BrowserDialogHandleResult, BrowserDialogState } from '../browser/dialogController.js';
import type { DocumentContentOptions, DocumentContentSnapshot } from '../browser/documentContent.js';
import type { BrowserDownloadSummary } from '../browser/downloadController.js';
import type { BrowserFileUploadResult } from '../browser/fileUploadController.js';
import type { BrowserHistoryAction, BrowserHistoryOptions, BrowserHistoryResult } from '../browser/historyController.js';
import type { NetworkIdleOptions, NetworkIdleResult } from '../browser/networkActivityMonitor.js';
import type { BrowserNavigationOptions, BrowserNavigationResult } from '../browser/navigationController.js';
import type { BrowserSelectMatch, BrowserSelectResult } from '../browser/selectController.js';
import type { BrowserTargetSummary, CloseBrowserTargetResult, CreateBrowserTargetResult } from '../browser/targetController.js';
import type { TargetQuery } from '../model/targetResolver.js';
import type { InteractionNode, Point } from '../types.js';
import type { TaskPageSelection, TaskRisk, TaskStep } from './taskProgram.js';

export interface TaskEngineActionResult { status: string; target: InteractionNode | null; }
export interface TaskKeyActionResult { status: string; }
export interface TaskPageSwitchResult { status: string; targetId?: string; }

export interface TaskRuntimeEngine {
  prepare?(): Promise<void>;
  refresh(): Promise<InteractionNode[]>;
  browserState?(): Promise<BrowserStateSnapshot | undefined>;
  documentContent?(options?: DocumentContentOptions): Promise<DocumentContentSnapshot | undefined>;
  dialogState?(): BrowserDialogState | undefined;
  targetState?(): BrowserTargetSummary | undefined;
  downloadState?(): BrowserDownloadSummary | undefined;
  activate(query: TargetQuery | string, options?: { requireUnambiguous?: boolean; autoReveal?: boolean; method?: 'auto' | 'keyboard' | 'pointer'; key?: string }): Promise<TaskEngineActionResult>;
  hover?(query: TargetQuery | string, options?: { requireUnambiguous?: boolean; autoReveal?: boolean; timeoutMs?: number; maxSamples?: number; pollIntervalMs?: number }): Promise<TaskEngineActionResult>;
  typeInto(query: TargetQuery | string, text: string, options?: { requireUnambiguous?: boolean; autoReveal?: boolean; delayMs?: number; expectedValue?: string }): Promise<TaskEngineActionResult>;
  selectOption?(query: TargetQuery | string, option: string, options?: { requireUnambiguous?: boolean; by?: BrowserSelectMatch }): Promise<BrowserSelectResult>;
  pressKey?(key: string, options?: { timeoutMs?: number; maxSamples?: number; pollIntervalMs?: number }): Promise<TaskKeyActionResult>;
  scrollViewport?(delta: Point, options?: { timeoutMs?: number; maxSamples?: number; pollIntervalMs?: number }): Promise<TaskKeyActionResult>;
  uploadFiles?(query: TargetQuery | string, paths: readonly string[], options?: { requireUnambiguous?: boolean }): Promise<BrowserFileUploadResult>;
  switchPage?(target: TaskPageSelection): Promise<TaskPageSwitchResult>;
  waitForNetworkIdle?(options?: NetworkIdleOptions): Promise<NetworkIdleResult>;
  navigate?(url: string, options?: BrowserNavigationOptions): Promise<BrowserNavigationResult>;
  history?(action: BrowserHistoryAction, options?: BrowserHistoryOptions): Promise<BrowserHistoryResult>;
  handleDialog?(accept: boolean, promptText?: string): Promise<BrowserDialogHandleResult>;
  createPageTarget?(url: string): Promise<CreateBrowserTargetResult>;
  closeLatestUnattachedPage?(): Promise<CloseBrowserTargetResult | undefined>;
}

export type TaskRunStatus = 'completed' | 'failed' | 'invalid-program' | 'missing-input' | 'budget-exhausted' | 'loop-detected' | 'stalled' | 'policy-blocked';
export type TaskTraceOutcome = 'verified' | 'uploaded' | 'page-switched' | 'navigated' | 'history-navigated' | 'dialog-handled' | 'target-created' | 'target-closed' | 'failed' | 'exception' | 'asserted' | 'assertion-failed' | 'branch-then' | 'branch-else' | 'wait-satisfied' | 'wait-timeout' | 'completed' | 'completion-condition-failed' | 'policy-blocked';

export interface TaskTraceEntry {
  index: number;
  stepId: string;
  kind: TaskStep['kind'];
  outcome: TaskTraceOutcome;
  nextStepId?: string;
  targetId?: string;
  actionStatus?: string;
  /** Non-sensitive commitment classification only; amount/counterparty remain in approval context. */
  commitmentStatus?: BrowserCommitmentStatus;
  commitmentKind?: BrowserCommitmentKind;
  commitmentConfidence?: BrowserCommitmentConfidence;
  beforeFingerprint: string;
  afterFingerprint: string;
  browserStateChanged: boolean;
  visit: number;
}

export interface TaskApprovalContext {
  programName?: string;
  stepId: string;
  kind: 'activate' | 'hover' | 'type' | 'select-option' | 'upload' | 'press-key' | 'scroll-viewport' | 'switch-page' | 'navigate' | 'history' | 'handle-dialog' | 'open-tab' | 'close-latest-tab';
  risk: Exclude<TaskRisk, 'observe'>;
  visit: number;
  /** Present when the runtime inferred a page-side commitment immediately before the action. */
  commitment?: BrowserCommitmentSummary;
}

export interface TaskRuntimeOptions {
  maxSteps?: number;
  maxVisitsPerStep?: number;
  maxConsecutiveNoProgress?: number;
  requireUnambiguousTargets?: boolean;
  maxRisk?: TaskRisk;
  /** Defaults to `auto`. `off` restores declaration-only risk gating. */
  commitmentDetection?: 'auto' | 'off';
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
