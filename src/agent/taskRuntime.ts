import type { BrowserDialogHandleResult } from '../browser/dialogController.js';
import type { BrowserFileUploadResult } from '../browser/fileUploadController.js';
import type { BrowserHistoryResult } from '../browser/historyController.js';
import type { BrowserNavigationResult } from '../browser/navigationController.js';
import type { CloseBrowserTargetResult, CreateBrowserTargetResult } from '../browser/targetController.js';
import {
  validateTaskProgram,
  type ActivateTaskStep,
  type CloseLatestTabTaskStep,
  type HandleDialogTaskStep,
  type HistoryTaskStep,
  type HoverTaskStep,
  type NavigateTaskStep,
  type OpenTabTaskStep,
  type PressKeyTaskStep,
  type SwitchPageTaskStep,
  type TaskProgram,
  type TaskRisk,
  type TypeTaskStep,
  type UploadTaskStep,
} from './taskProgram.js';
import { evaluateTaskPredicate, observeTaskEngine, resolveProgramText } from './taskObservation.js';
import type {
  TaskEngineActionResult,
  TaskKeyActionResult,
  TaskPageSwitchResult,
  TaskRunResult,
  TaskRunStatus,
  TaskRuntimeEngine,
  TaskRuntimeOptions,
  TaskTraceEntry,
  TaskTraceOutcome,
} from './taskRuntimeContracts.js';

export * from './taskRuntimeContracts.js';
export { evaluateTaskPredicate, interactionSnapshotFingerprint, taskObservationFingerprint } from './taskObservation.js';

const RISK_RANK: Record<TaskRisk, number> = { observe: 0, interaction: 1, 'external-side-effect': 2 };
type ActionStep = ActivateTaskStep | HoverTaskStep | TypeTaskStep | UploadTaskStep | PressKeyTaskStep | SwitchPageTaskStep | NavigateTaskStep | HistoryTaskStep | HandleDialogTaskStep | OpenTabTaskStep | CloseLatestTabTaskStep;
type RuntimeActionResult = TaskEngineActionResult | TaskKeyActionResult | BrowserFileUploadResult | TaskPageSwitchResult | BrowserNavigationResult | BrowserHistoryResult | BrowserDialogHandleResult | CreateBrowserTargetResult | CloseBrowserTargetResult;

const positiveInt = (value: number | undefined, fallback: number) => value === undefined || !Number.isFinite(value) ? fallback : Math.max(1, Math.floor(value));
async function sleep(ms: number): Promise<void> { if (ms > 0) await new Promise<void>((resolve) => setTimeout(resolve, ms)); }
function riskOf(step: ActionStep): Exclude<TaskRisk, 'observe'> { if (step.kind === 'upload') return 'external-side-effect'; return step.risk ?? 'interaction'; }
function actionSucceeded(step: ActionStep, result: RuntimeActionResult | undefined): boolean { if (!result) return false; switch (step.kind) { case 'upload': return result.status === 'uploaded'; case 'switch-page': return result.status === 'switched'; case 'navigate': case 'history': return result.status === 'navigated'; case 'handle-dialog': return result.status === 'handled'; case 'open-tab': return result.status === 'created'; case 'close-latest-tab': return result.status === 'closed'; default: return result.status === 'verified'; } }
function successOutcome(step: ActionStep): TaskTraceOutcome { switch (step.kind) { case 'upload': return 'uploaded'; case 'switch-page': return 'page-switched'; case 'navigate': return 'navigated'; case 'history': return 'history-navigated'; case 'handle-dialog': return 'dialog-handled'; case 'open-tab': return 'target-created'; case 'close-latest-tab': return 'target-closed'; default: return 'verified'; } }

async function performAction(engine: TaskRuntimeEngine, step: ActionStep, inputs: Readonly<Record<string, string>>, options: TaskRuntimeOptions): Promise<RuntimeActionResult | undefined> {
  switch (step.kind) {
    case 'activate': return engine.activate(step.target, { requireUnambiguous: options.requireUnambiguousTargets ?? true, autoReveal: step.autoReveal, method: step.method, key: step.key });
    case 'hover': return engine.hover?.(step.target, { requireUnambiguous: options.requireUnambiguousTargets ?? true, autoReveal: step.autoReveal, timeoutMs: step.timeoutMs, maxSamples: step.maxSamples, pollIntervalMs: step.pollIntervalMs });
    case 'type': return engine.typeInto(step.target, resolveProgramText(step.text, inputs), { requireUnambiguous: options.requireUnambiguousTargets ?? true, autoReveal: step.autoReveal, delayMs: step.delayMs, expectedValue: step.expectedValue === undefined ? undefined : resolveProgramText(step.expectedValue, inputs) });
    case 'upload': return engine.uploadFiles?.(step.target, step.files.map((file) => resolveProgramText(file, inputs)), { requireUnambiguous: options.requireUnambiguousTargets ?? true });
    case 'press-key': return engine.pressKey?.(step.key, { timeoutMs: step.timeoutMs, maxSamples: step.maxSamples, pollIntervalMs: step.pollIntervalMs });
    case 'switch-page': return engine.switchPage?.(step.target);
    case 'navigate': return engine.navigate?.(resolveProgramText(step.url, inputs), { waitUntil: step.waitUntil, timeoutMs: step.timeoutMs, maxPolls: step.maxPolls, pollIntervalMs: step.pollIntervalMs });
    case 'history': return engine.history?.(step.action, { waitUntil: step.waitUntil, timeoutMs: step.timeoutMs, maxPolls: step.maxPolls, pollIntervalMs: step.pollIntervalMs, ignoreCache: step.ignoreCache });
    case 'handle-dialog': return engine.handleDialog?.(step.accept, step.promptText === undefined ? undefined : resolveProgramText(step.promptText, inputs));
    case 'open-tab': return engine.createPageTarget?.(resolveProgramText(step.url, inputs));
    case 'close-latest-tab': return engine.closeLatestUnattachedPage?.();
  }
}

export class TaskRuntime {
  constructor(private readonly engine: TaskRuntimeEngine) {}
  async run(program: TaskProgram, inputs: Readonly<Record<string, string>> = {}, options: TaskRuntimeOptions = {}): Promise<TaskRunResult> {
    const validation = validateTaskProgram(program);
    if (!validation.valid) return { status: 'invalid-program', completed: false, stepsExecuted: 0, trace: [], validationErrors: validation.errors, validationWarnings: validation.warnings };
    const missingInputs = (program.inputs ?? []).filter((name) => inputs[name] === undefined);
    if (missingInputs.length) return { status: 'missing-input', completed: false, stepsExecuted: 0, trace: [], validationWarnings: validation.warnings, missingInputs };
    try { await this.engine.prepare?.(); } catch { return { status: 'failed', completed: false, stepsExecuted: 0, trace: [], validationWarnings: validation.warnings }; }

    const stepMap = new Map(program.steps.map((step) => [step.id, step] as const));
    const maxSteps = positiveInt(options.maxSteps, 64), maxVisits = positiveInt(options.maxVisitsPerStep, 8), maxNoProgress = positiveInt(options.maxConsecutiveNoProgress, 4), maxRisk = options.maxRisk ?? 'interaction';
    const trace: TaskTraceEntry[] = [], visits = new Map<string, number>();
    let currentId = program.entry, consecutiveNoProgress = 0;
    const emit = async (entry: TaskTraceEntry) => { trace.push(entry); try { await options.onTrace?.(entry); } catch {} };
    const failed = (status: TaskRunStatus, stepsExecuted: number): TaskRunResult => ({ status, completed: false, finalStepId: currentId, stepsExecuted, trace, validationWarnings: validation.warnings });

    for (let index = 0; index < maxSteps; index += 1) {
      const step = stepMap.get(currentId)!;
      const visit = (visits.get(currentId) ?? 0) + 1; visits.set(currentId, visit);
      if (visit > maxVisits) return failed('loop-detected', index);
      let before; try { before = await observeTaskEngine(this.engine); } catch { return failed('failed', index); }

      if (step.kind === 'activate' || step.kind === 'hover' || step.kind === 'type' || step.kind === 'upload' || step.kind === 'press-key' || step.kind === 'switch-page' || step.kind === 'navigate' || step.kind === 'history' || step.kind === 'handle-dialog' || step.kind === 'open-tab' || step.kind === 'close-latest-tab') {
        const risk = riskOf(step), needsApproval = RISK_RANK[risk] > RISK_RANK[maxRisk] || step.requiresApproval === true;
        let approved = !needsApproval;
        if (needsApproval && options.approve) { try { approved = await options.approve({ programName: program.name, stepId: step.id, kind: step.kind, risk, visit }); } catch { approved = false; } }
        if (!approved) { await emit({ index, stepId: step.id, kind: step.kind, outcome: 'policy-blocked', beforeFingerprint: before.fingerprint, afterFingerprint: before.fingerprint, browserStateChanged: false, visit }); return failed('policy-blocked', index + 1); }

        let action: RuntimeActionResult | undefined, threw = false;
        try { action = await performAction(this.engine, step, inputs, options); } catch { threw = true; }
        let after = before; try { after = await observeTaskEngine(this.engine); } catch {}
        const changed = before.fingerprint !== after.fingerprint; consecutiveNoProgress = changed ? 0 : consecutiveNoProgress + 1;
        const succeeded = actionSucceeded(step, action), nextId = succeeded ? step.next : step.onFailure;
        const targetId = action && 'target' in action ? action.target?.id : action && 'targetId' in action ? action.targetId : undefined;
        await emit({ index, stepId: step.id, kind: step.kind, outcome: threw ? 'exception' : succeeded ? successOutcome(step) : 'failed', ...(nextId ? { nextStepId: nextId } : {}), ...(targetId ? { targetId } : {}), ...(action ? { actionStatus: action.status } : {}), beforeFingerprint: before.fingerprint, afterFingerprint: after.fingerprint, browserStateChanged: changed, visit });
        if (consecutiveNoProgress >= maxNoProgress) return failed('stalled', index + 1);
        if (!nextId) return failed('failed', index + 1);
        currentId = nextId; continue;
      }

      const predicate = (condition: Parameters<typeof evaluateTaskPredicate>[0]) => evaluateTaskPredicate(condition, before.nodes, inputs, before.browser, before.dialog, before.targets, before.downloads);
      if (step.kind === 'assert') { const passed = predicate(step.condition), nextId = passed ? step.next : step.onFailure; await emit({ index, stepId: step.id, kind: step.kind, outcome: passed ? 'asserted' : 'assertion-failed', ...(nextId ? { nextStepId: nextId } : {}), beforeFingerprint: before.fingerprint, afterFingerprint: before.fingerprint, browserStateChanged: false, visit }); if (!nextId) return failed('failed', index + 1); currentId = nextId; continue; }
      if (step.kind === 'branch') { const passed = predicate(step.condition), nextId = passed ? step.then : step.else; await emit({ index, stepId: step.id, kind: step.kind, outcome: passed ? 'branch-then' : 'branch-else', nextStepId: nextId, beforeFingerprint: before.fingerprint, afterFingerprint: before.fingerprint, browserStateChanged: false, visit }); currentId = nextId; continue; }
      if (step.kind === 'wait') { const maxPolls = positiveInt(step.maxPolls, positiveInt(options.waitMaxPolls, 20)), pollIntervalMs = Math.max(0, step.pollIntervalMs ?? options.waitPollIntervalMs ?? 100); let observed = before, passed = predicate(step.condition); for (let poll = 1; !passed && poll < maxPolls; poll += 1) { await sleep(pollIntervalMs); try { observed = await observeTaskEngine(this.engine); } catch { break; } passed = evaluateTaskPredicate(step.condition, observed.nodes, inputs, observed.browser, observed.dialog, observed.targets, observed.downloads); } const nextId = passed ? step.next : step.onTimeout; await emit({ index, stepId: step.id, kind: step.kind, outcome: passed ? 'wait-satisfied' : 'wait-timeout', ...(nextId ? { nextStepId: nextId } : {}), beforeFingerprint: before.fingerprint, afterFingerprint: observed.fingerprint, browserStateChanged: before.fingerprint !== observed.fingerprint, visit }); if (!nextId) return failed('failed', index + 1); currentId = nextId; continue; }
      if (step.kind === 'wait-network-idle') {
        let idle = false;
        try {
          const result = await this.engine.waitForNetworkIdle?.({ quietMs: step.quietMs, maxInflight: step.maxInflight, timeoutMs: step.timeoutMs, pollIntervalMs: step.pollIntervalMs });
          idle = result?.idle === true;
        } catch {}
        let after = before; try { after = await observeTaskEngine(this.engine); } catch {}
        const nextId = idle ? step.next : step.onTimeout;
        await emit({ index, stepId: step.id, kind: step.kind, outcome: idle ? 'wait-satisfied' : 'wait-timeout', ...(nextId ? { nextStepId: nextId } : {}), beforeFingerprint: before.fingerprint, afterFingerprint: after.fingerprint, browserStateChanged: before.fingerprint !== after.fingerprint, visit });
        if (!nextId) return failed('failed', index + 1);
        currentId = nextId; continue;
      }
      if (step.kind === 'fail') { await emit({ index, stepId: step.id, kind: step.kind, outcome: 'failed', beforeFingerprint: before.fingerprint, afterFingerprint: before.fingerprint, browserStateChanged: false, visit }); return failed('failed', index + 1); }
      const passed = step.condition ? predicate(step.condition) : true, nextId = passed ? undefined : step.onFailure;
      await emit({ index, stepId: step.id, kind: step.kind, outcome: passed ? 'completed' : 'completion-condition-failed', ...(nextId ? { nextStepId: nextId } : {}), beforeFingerprint: before.fingerprint, afterFingerprint: before.fingerprint, browserStateChanged: false, visit });
      if (passed) return { status: 'completed', completed: true, finalStepId: currentId, stepsExecuted: index + 1, trace, validationWarnings: validation.warnings };
      if (!nextId) return failed('failed', index + 1); currentId = nextId;
    }
    return failed('budget-exhausted', maxSteps);
  }
}
