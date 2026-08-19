import type { BrowserDocumentReadyState } from '../browser/browserState.js';
import type { BrowserDialogType } from '../browser/dialogController.js';
import type { BrowserHistoryAction } from '../browser/historyController.js';
import type { NavigationWaitUntil } from '../browser/navigationController.js';
import type { TargetQuery } from '../model/targetResolver.js';

export const MAX_TASK_VIEWPORT_SCROLL_DELTA_PX = 4000;

export type TaskTarget = TargetQuery | string;
export type TaskRisk = 'observe' | 'interaction' | 'external-side-effect';
export type TaskPageSelection = 'latest-page' | 'latest-unattached-page';
export type ProgramText = string | { input: string };

export interface TaskNodeExpectation { focused?: boolean; disabled?: boolean; expanded?: boolean; checked?: boolean | 'mixed'; selected?: boolean; pressed?: boolean | 'mixed'; value?: ProgramText; valueIncludes?: ProgramText; }
export interface TaskBrowserTargetsExpectation { pageCountAtLeast?: number; unattachedPageCountAtLeast?: number; }
export interface TaskDownloadExpectation { completedCountAtLeast?: number; inProgressCountAtLeast?: number; canceledCountAtLeast?: number; }
export interface TaskDialogExpectation { open?: boolean; type?: BrowserDialogType; }
export interface TaskBrowserExpectation { url?: ProgramText; urlIncludes?: ProgramText; origin?: ProgramText; title?: ProgramText; titleIncludes?: ProgramText; readyState?: BrowserDocumentReadyState; historyLength?: number; historyLengthAtLeast?: number; }

export type TaskPredicate =
  | { kind: 'exists'; target: TaskTarget; unambiguous?: boolean }
  | { kind: 'state'; target: TaskTarget; state: TaskNodeExpectation; unambiguous?: boolean }
  | { kind: 'browser'; state: TaskBrowserExpectation }
  | { kind: 'dialog'; state: TaskDialogExpectation }
  | { kind: 'targets'; state: TaskBrowserTargetsExpectation }
  | { kind: 'downloads'; state: TaskDownloadExpectation }
  | { kind: 'all'; predicates: readonly TaskPredicate[] }
  | { kind: 'any'; predicates: readonly TaskPredicate[] }
  | { kind: 'not'; predicate: TaskPredicate };

export interface TaskActionStepBase { id: string; description?: string; risk?: Exclude<TaskRisk, 'observe'>; requiresApproval?: boolean; next: string; onFailure?: string; }
export interface SemanticTaskActionStepBase extends TaskActionStepBase { autoReveal?: boolean; }
export interface ActivateTaskStep extends SemanticTaskActionStepBase { kind: 'activate'; target: TaskTarget; method?: 'auto' | 'keyboard' | 'pointer'; key?: string; }
export interface HoverTaskStep extends SemanticTaskActionStepBase { kind: 'hover'; target: TaskTarget; timeoutMs?: number; maxSamples?: number; pollIntervalMs?: number; }
export interface TypeTaskStep extends SemanticTaskActionStepBase { kind: 'type'; target: TaskTarget; text: ProgramText; expectedValue?: ProgramText; delayMs?: number; }
export interface UploadTaskStep extends Omit<TaskActionStepBase, 'risk'> { kind: 'upload'; risk?: 'external-side-effect'; target: TaskTarget; files: readonly ProgramText[]; }
/** Key/chord is static program data; browser content cannot synthesize it at runtime. */
export interface PressKeyTaskStep extends TaskActionStepBase { kind: 'press-key'; key: string; timeoutMs?: number; maxSamples?: number; pollIntervalMs?: number; }
/** Static top-level wheel delta; each axis is capped to MAX_TASK_VIEWPORT_SCROLL_DELTA_PX. */
export interface ScrollViewportTaskStep extends TaskActionStepBase { kind: 'scroll-viewport'; deltaX?: number; deltaY?: number; timeoutMs?: number; maxSamples?: number; pollIntervalMs?: number; }
export interface SwitchPageTaskStep extends TaskActionStepBase { kind: 'switch-page'; target: TaskPageSelection; }
export interface OpenTabTaskStep extends TaskActionStepBase { kind: 'open-tab'; url: ProgramText; }
export interface CloseLatestTabTaskStep extends TaskActionStepBase { kind: 'close-latest-tab'; }
export interface HandleDialogTaskStep extends TaskActionStepBase { kind: 'handle-dialog'; accept: boolean; promptText?: ProgramText; }
export interface NavigateTaskStep extends TaskActionStepBase { kind: 'navigate'; url: ProgramText; waitUntil?: NavigationWaitUntil; timeoutMs?: number; maxPolls?: number; pollIntervalMs?: number; }
export interface HistoryTaskStep extends TaskActionStepBase { kind: 'history'; action: BrowserHistoryAction; waitUntil?: NavigationWaitUntil; timeoutMs?: number; maxPolls?: number; pollIntervalMs?: number; ignoreCache?: boolean; }
export interface AssertTaskStep { id: string; kind: 'assert'; description?: string; condition: TaskPredicate; next: string; onFailure?: string; }
export interface BranchTaskStep { id: string; kind: 'branch'; description?: string; condition: TaskPredicate; then: string; else: string; }
export interface WaitTaskStep { id: string; kind: 'wait'; description?: string; condition: TaskPredicate; next: string; onTimeout?: string; maxPolls?: number; pollIntervalMs?: number; }
/** Observe-only quiet-network wait. It never participates in interaction risk/approval. */
export interface WaitNetworkIdleTaskStep { id: string; kind: 'wait-network-idle'; description?: string; next: string; onTimeout?: string; quietMs?: number; maxInflight?: number; timeoutMs?: number; pollIntervalMs?: number; }
export interface FailTaskStep { id: string; kind: 'fail'; description?: string; }
export interface CompleteTaskStep { id: string; kind: 'complete'; description?: string; condition?: TaskPredicate; onFailure?: string; }

export type TaskStep = ActivateTaskStep | HoverTaskStep | TypeTaskStep | UploadTaskStep | PressKeyTaskStep | ScrollViewportTaskStep | SwitchPageTaskStep | NavigateTaskStep | HistoryTaskStep | HandleDialogTaskStep | OpenTabTaskStep | CloseLatestTabTaskStep | AssertTaskStep | BranchTaskStep | WaitTaskStep | WaitNetworkIdleTaskStep | FailTaskStep | CompleteTaskStep;
export interface TaskProgram { version: 1; name?: string; entry: string; inputs?: readonly string[]; steps: readonly TaskStep[]; }
export interface TaskProgramValidation { valid: boolean; errors: string[]; warnings: string[]; }

function collectProgramTextInput(text: ProgramText | undefined, into: Set<string>): void { if (text && typeof text !== 'string') into.add(text.input); }
function collectBrowserExpectationInputs(state: TaskBrowserExpectation, into: Set<string>): void { collectProgramTextInput(state.url, into); collectProgramTextInput(state.urlIncludes, into); collectProgramTextInput(state.origin, into); collectProgramTextInput(state.title, into); collectProgramTextInput(state.titleIncludes, into); }
function collectPredicateInputs(predicate: TaskPredicate, into: Set<string>): void {
  switch (predicate.kind) {
    case 'state': collectProgramTextInput(predicate.state.value, into); collectProgramTextInput(predicate.state.valueIncludes, into); return;
    case 'browser': collectBrowserExpectationInputs(predicate.state, into); return;
    case 'dialog': case 'targets': case 'downloads': case 'exists': return;
    case 'all': case 'any': for (const nested of predicate.predicates) collectPredicateInputs(nested, into); return;
    case 'not': collectPredicateInputs(predicate.predicate, into); return;
  }
}
function referencedStepIds(step: TaskStep): string[] {
  switch (step.kind) {
    case 'activate': case 'hover': case 'type': case 'upload': case 'press-key': case 'scroll-viewport': case 'switch-page': case 'navigate': case 'history': case 'handle-dialog': case 'open-tab': case 'close-latest-tab': case 'assert': return [step.next, ...(step.onFailure ? [step.onFailure] : [])];
    case 'branch': return [step.then, step.else];
    case 'wait': case 'wait-network-idle': return [step.next, ...(step.onTimeout ? [step.onTimeout] : [])];
    case 'fail': return [];
    case 'complete': return step.onFailure ? [step.onFailure] : [];
  }
}
function stepInputs(step: TaskStep): Set<string> {
  const inputs = new Set<string>();
  if (step.kind === 'type') { collectProgramTextInput(step.text, inputs); collectProgramTextInput(step.expectedValue, inputs); }
  if (step.kind === 'upload') for (const file of step.files) collectProgramTextInput(file, inputs);
  if (step.kind === 'navigate') collectProgramTextInput(step.url, inputs);
  if (step.kind === 'handle-dialog') collectProgramTextInput(step.promptText, inputs);
  if (step.kind === 'open-tab') collectProgramTextInput(step.url, inputs);
  if (step.kind === 'assert' || step.kind === 'branch' || step.kind === 'wait') collectPredicateInputs(step.condition, inputs);
  if (step.kind === 'complete' && step.condition) collectPredicateInputs(step.condition, inputs);
  return inputs;
}
function validatePollFields(id: string, maxPolls: number | undefined, pollIntervalMs: number | undefined, errors: string[]): void { if (maxPolls !== undefined && (!Number.isInteger(maxPolls) || maxPolls < 1)) errors.push(`step ${id} maxPolls must be a positive integer`); if (pollIntervalMs !== undefined && (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0)) errors.push(`step ${id} pollIntervalMs must be non-negative`); }
function validateObservationFields(kind: 'press-key' | 'hover' | 'scroll-viewport', id: string, maxSamples: number | undefined, pollIntervalMs: number | undefined, timeoutMs: number | undefined, errors: string[]): void {
  if (maxSamples !== undefined && (!Number.isInteger(maxSamples) || maxSamples < 1)) errors.push(`${kind} step ${id} maxSamples must be a positive integer`);
  if (pollIntervalMs !== undefined && (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0)) errors.push(`${kind} step ${id} pollIntervalMs must be non-negative`);
  if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 1)) errors.push(`${kind} step ${id} timeoutMs must be positive`);
}
function validatePredicate(predicate: TaskPredicate, stepId: string, errors: string[]): void {
  switch (predicate.kind) {
    case 'browser': { const { historyLength, historyLengthAtLeast } = predicate.state; if (historyLength !== undefined && (!Number.isInteger(historyLength) || historyLength < 0)) errors.push(`step ${stepId} browser historyLength must be a non-negative integer`); if (historyLengthAtLeast !== undefined && (!Number.isInteger(historyLengthAtLeast) || historyLengthAtLeast < 0)) errors.push(`step ${stepId} browser historyLengthAtLeast must be a non-negative integer`); return; }
    case 'targets': { const { pageCountAtLeast, unattachedPageCountAtLeast } = predicate.state; if (pageCountAtLeast !== undefined && (!Number.isInteger(pageCountAtLeast) || pageCountAtLeast < 0)) errors.push(`step ${stepId} targets pageCountAtLeast must be a non-negative integer`); if (unattachedPageCountAtLeast !== undefined && (!Number.isInteger(unattachedPageCountAtLeast) || unattachedPageCountAtLeast < 0)) errors.push(`step ${stepId} targets unattachedPageCountAtLeast must be a non-negative integer`); return; }
    case 'downloads': for (const [name, value] of Object.entries(predicate.state)) if (value !== undefined && (!Number.isInteger(value) || value < 0)) errors.push(`step ${stepId} downloads ${name} must be a non-negative integer`); return;
    case 'all': case 'any': for (const nested of predicate.predicates) validatePredicate(nested, stepId, errors); return;
    case 'not': validatePredicate(predicate.predicate, stepId, errors); return;
    default: return;
  }
}

export function validateTaskProgram(program: TaskProgram): TaskProgramValidation {
  const errors: string[] = [], warnings: string[] = [], declaredInputs = new Set(program.inputs ?? []), stepMap = new Map<string, TaskStep>();
  if (program.version !== 1) errors.push(`unsupported program version: ${String(program.version)}`);
  if (!program.entry) errors.push('entry step id is required');
  for (const input of declaredInputs) if (!input.trim()) errors.push('input names must be non-empty');
  if (declaredInputs.size !== (program.inputs?.length ?? 0)) errors.push('input names must be unique');
  for (const step of program.steps) {
    if (!step.id.trim()) { errors.push('step ids must be non-empty'); continue; }
    if (stepMap.has(step.id)) errors.push(`duplicate step id: ${step.id}`); else stepMap.set(step.id, step);
    if (step.kind === 'upload' && step.files.length < 1) errors.push(`upload step ${step.id} requires at least one file`);
    if (step.kind === 'press-key') {
      if (!step.key.trim()) errors.push(`press-key step ${step.id} key must be non-empty`);
      validateObservationFields('press-key', step.id, step.maxSamples, step.pollIntervalMs, step.timeoutMs, errors);
    }
    if (step.kind === 'hover') validateObservationFields('hover', step.id, step.maxSamples, step.pollIntervalMs, step.timeoutMs, errors);
    if (step.kind === 'scroll-viewport') {
      const deltaX = step.deltaX ?? 0, deltaY = step.deltaY ?? 0;
      if (!Number.isFinite(deltaX) || !Number.isFinite(deltaY)) errors.push(`scroll-viewport step ${step.id} deltas must be finite`);
      if (deltaX === 0 && deltaY === 0) errors.push(`scroll-viewport step ${step.id} requires a non-zero delta`);
      if (Math.abs(deltaX) > MAX_TASK_VIEWPORT_SCROLL_DELTA_PX || Math.abs(deltaY) > MAX_TASK_VIEWPORT_SCROLL_DELTA_PX) errors.push(`scroll-viewport step ${step.id} deltas must not exceed ${MAX_TASK_VIEWPORT_SCROLL_DELTA_PX}px per axis`);
      validateObservationFields('scroll-viewport', step.id, step.maxSamples, step.pollIntervalMs, step.timeoutMs, errors);
    }
    if (step.kind === 'wait-network-idle') {
      if (step.quietMs !== undefined && (!Number.isFinite(step.quietMs) || step.quietMs < 0)) errors.push(`wait-network-idle step ${step.id} quietMs must be non-negative`);
      if (step.maxInflight !== undefined && (!Number.isInteger(step.maxInflight) || step.maxInflight < 0)) errors.push(`wait-network-idle step ${step.id} maxInflight must be a non-negative integer`);
      if (step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs < 0)) errors.push(`wait-network-idle step ${step.id} timeoutMs must be non-negative`);
      if (step.pollIntervalMs !== undefined && (!Number.isFinite(step.pollIntervalMs) || step.pollIntervalMs < 0)) errors.push(`wait-network-idle step ${step.id} pollIntervalMs must be non-negative`);
    }
    if (step.kind === 'wait' || step.kind === 'navigate' || step.kind === 'history') validatePollFields(step.id, step.maxPolls, step.pollIntervalMs, errors);
    if ((step.kind === 'navigate' || step.kind === 'history') && step.timeoutMs !== undefined && (!Number.isFinite(step.timeoutMs) || step.timeoutMs < 1)) errors.push(`${step.kind} step ${step.id} timeoutMs must be positive`);
    if (step.kind === 'type' && step.delayMs !== undefined && (!Number.isFinite(step.delayMs) || step.delayMs < 0)) errors.push(`type step ${step.id} delayMs must be non-negative`);
    if (step.kind === 'assert' || step.kind === 'branch' || step.kind === 'wait') validatePredicate(step.condition, step.id, errors);
    if (step.kind === 'complete' && step.condition) validatePredicate(step.condition, step.id, errors);
  }
  if (!stepMap.has(program.entry)) errors.push(`entry step does not exist: ${program.entry}`);
  for (const step of program.steps) { for (const ref of referencedStepIds(step)) if (!stepMap.has(ref)) errors.push(`step ${step.id} references missing step: ${ref}`); for (const input of stepInputs(step)) if (!declaredInputs.has(input)) errors.push(`step ${step.id} references undeclared input: ${input}`); }
  if (errors.length === 0) { const reachable = new Set<string>(), queue = [program.entry]; let reachableComplete = false; while (queue.length) { const id = queue.shift()!; if (reachable.has(id)) continue; reachable.add(id); const step = stepMap.get(id)!; if (step.kind === 'complete') reachableComplete = true; for (const ref of referencedStepIds(step)) queue.push(ref); } if (!reachableComplete) errors.push('program has no reachable complete step'); for (const id of stepMap.keys()) if (!reachable.has(id)) warnings.push(`unreachable step: ${id}`); }
  return { valid: errors.length === 0, errors, warnings };
}
