import type { InteractionNode } from '../types.js';
import { resolveInteractionTargetDetailed, type TargetQuery } from '../model/targetResolver.js';
import {
  validateTaskProgram,
  type ActivateTaskStep,
  type ProgramText,
  type TaskPredicate,
  type TaskProgram,
  type TaskRisk,
  type TaskStep,
  type TypeTaskStep,
} from './taskProgram.js';

export interface TaskEngineActionResult {
  status: string;
  target: InteractionNode | null;
}

/** Minimal structural contract implemented by InteractionEngine. */
export interface TaskRuntimeEngine {
  refresh(): Promise<InteractionNode[]>;
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
  kind: 'activate' | 'type';
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

const RISK_RANK: Record<TaskRisk, number> = {
  observe: 0,
  interaction: 1,
  'external-side-effect': 2,
};

function resolveProgramText(text: ProgramText, inputs: Readonly<Record<string, string>>): string {
  if (typeof text === 'string') return text;
  return inputs[text.input]!;
}

function matchesExpectation(
  node: InteractionNode,
  state: Extract<TaskPredicate, { kind: 'state' }>['state'],
  inputs: Readonly<Record<string, string>>,
): boolean {
  if (state.focused !== undefined && node.focused !== state.focused) return false;
  if (state.disabled !== undefined && node.disabled !== state.disabled) return false;
  if (state.expanded !== undefined && node.expanded !== state.expanded) return false;
  if (state.checked !== undefined && node.checked !== state.checked) return false;
  if (state.selected !== undefined && node.selected !== state.selected) return false;
  if (state.pressed !== undefined && node.pressed !== state.pressed) return false;
  if (state.value !== undefined && node.value !== resolveProgramText(state.value, inputs)) return false;
  if (state.valueIncludes !== undefined && !node.value?.includes(resolveProgramText(state.valueIncludes, inputs))) return false;
  return true;
}

export function evaluateTaskPredicate(
  predicate: TaskPredicate,
  nodes: readonly InteractionNode[],
  inputs: Readonly<Record<string, string>> = {},
): boolean {
  switch (predicate.kind) {
    case 'exists': {
      const resolution = resolveInteractionTargetDetailed(nodes, predicate.target);
      return resolution.target !== null && (!predicate.unambiguous || !resolution.ambiguous);
    }
    case 'state': {
      const resolution = resolveInteractionTargetDetailed(nodes, predicate.target);
      if (!resolution.target || (predicate.unambiguous && resolution.ambiguous)) return false;
      return matchesExpectation(resolution.target, predicate.state, inputs);
    }
    case 'all':
      return predicate.predicates.every((nested) => evaluateTaskPredicate(nested, nodes, inputs));
    case 'any':
      return predicate.predicates.some((nested) => evaluateTaskPredicate(nested, nodes, inputs));
    case 'not':
      return !evaluateTaskPredicate(predicate.predicate, nodes, inputs);
  }
}

function fingerprintField(value: unknown): string {
  if (value === undefined) return '';
  return String(value);
}

/** Semantic fingerprint used for progress/loop detection without recording page text in traces. */
export function interactionSnapshotFingerprint(nodes: readonly InteractionNode[]): string {
  const stable = [...nodes]
    .filter((node) => node.id !== '@cursor')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => [
      node.id,
      node.frameId,
      node.role ?? '',
      node.name ?? '',
      node.value ?? '',
      fingerprintField(node.focused),
      fingerprintField(node.disabled),
      fingerprintField(node.expanded),
      fingerprintField(node.checked),
      fingerprintField(node.selected),
      fingerprintField(node.pressed),
      node.activeDescendantId ?? '',
      fingerprintField(node.viewportVisible),
      fingerprintField(node.mainViewportVisible),
    ].join('\u001f'))
    .join('\u001e');

  let hash = 0x811c9dc5;
  for (let i = 0; i < stable.length; i += 1) {
    hash ^= stable.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

function actionRisk(step: ActivateTaskStep | TypeTaskStep): Exclude<TaskRisk, 'observe'> {
  return step.risk ?? 'interaction';
}

function actionSucceeded(result: TaskEngineActionResult): boolean {
  return result.status === 'verified';
}

function normalizedPositiveInteger(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

async function sleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Executes a precompiled task graph over InteractionEngine. It deliberately has
 * no callback that can synthesize new runtime actions from page content.
 */
export class TaskRuntime {
  constructor(private readonly engine: TaskRuntimeEngine) {}

  async run(
    program: TaskProgram,
    inputs: Readonly<Record<string, string>> = {},
    options: TaskRuntimeOptions = {},
  ): Promise<TaskRunResult> {
    const validation = validateTaskProgram(program);
    if (!validation.valid) {
      return {
        status: 'invalid-program',
        completed: false,
        stepsExecuted: 0,
        trace: [],
        validationErrors: validation.errors,
        validationWarnings: validation.warnings,
      };
    }

    const missingInputs = (program.inputs ?? []).filter((name) => inputs[name] === undefined);
    if (missingInputs.length) {
      return {
        status: 'missing-input',
        completed: false,
        stepsExecuted: 0,
        trace: [],
        validationWarnings: validation.warnings,
        missingInputs,
      };
    }

    const stepMap = new Map(program.steps.map((step) => [step.id, step] as const));
    const maxSteps = normalizedPositiveInteger(options.maxSteps, 64);
    const maxVisits = normalizedPositiveInteger(options.maxVisitsPerStep, 8);
    const maxNoProgress = normalizedPositiveInteger(options.maxConsecutiveNoProgress, 4);
    const maxRisk = options.maxRisk ?? 'interaction';
    const trace: TaskTraceEntry[] = [];
    const visits = new Map<string, number>();
    let currentId = program.entry;
    let consecutiveNoProgress = 0;

    const emit = async (entry: TaskTraceEntry) => {
      trace.push(entry);
      try {
        await options.onTrace?.(entry);
      } catch {
        // Observability must not become a hidden browser-control dependency.
      }
    };

    for (let index = 0; index < maxSteps; index += 1) {
      const step = stepMap.get(currentId)!;
      const visit = (visits.get(currentId) ?? 0) + 1;
      visits.set(currentId, visit);
      if (visit > maxVisits) {
        return {
          status: 'loop-detected',
          completed: false,
          finalStepId: currentId,
          stepsExecuted: index,
          trace,
          validationWarnings: validation.warnings,
        };
      }

      let before: InteractionNode[];
      try {
        before = await this.engine.refresh();
      } catch {
        return {
          status: 'failed',
          completed: false,
          finalStepId: currentId,
          stepsExecuted: index,
          trace,
          validationWarnings: validation.warnings,
        };
      }
      const beforeFingerprint = interactionSnapshotFingerprint(before);

      if (step.kind === 'activate' || step.kind === 'type') {
        const risk = actionRisk(step);
        const overRiskBudget = RISK_RANK[risk] > RISK_RANK[maxRisk];
        const needsApproval = overRiskBudget || step.requiresApproval === true;
        let approved = !needsApproval;
        if (needsApproval && options.approve) {
          try {
            approved = await options.approve({
              programName: program.name,
              stepId: step.id,
              kind: step.kind,
              risk,
              visit,
            });
          } catch {
            approved = false;
          }
        }
        if (!approved) {
          await emit({
            index,
            stepId: step.id,
            kind: step.kind,
            outcome: 'policy-blocked',
            beforeFingerprint,
            afterFingerprint: beforeFingerprint,
            browserStateChanged: false,
            visit,
          });
          return {
            status: 'policy-blocked',
            completed: false,
            finalStepId: currentId,
            stepsExecuted: index + 1,
            trace,
            validationWarnings: validation.warnings,
          };
        }

        let action: TaskEngineActionResult | undefined;
        let threw = false;
        try {
          if (step.kind === 'activate') {
            action = await this.engine.activate(step.target, {
              requireUnambiguous: options.requireUnambiguousTargets ?? true,
              autoReveal: step.autoReveal,
              method: step.method,
              key: step.key,
            });
          } else {
            const text = resolveProgramText(step.text, inputs);
            action = await this.engine.typeInto(step.target, text, {
              requireUnambiguous: options.requireUnambiguousTargets ?? true,
              autoReveal: step.autoReveal,
              delayMs: step.delayMs,
              expectedValue: step.expectedValue === undefined
                ? undefined
                : resolveProgramText(step.expectedValue, inputs),
            });
          }
        } catch {
          threw = true;
        }

        let after = before;
        try {
          after = await this.engine.refresh();
        } catch {
          // Preserve the last known state and fail closed below.
        }
        const afterFingerprint = interactionSnapshotFingerprint(after);
        const changed = beforeFingerprint !== afterFingerprint;
        consecutiveNoProgress = changed ? 0 : consecutiveNoProgress + 1;
        const succeeded = action !== undefined && actionSucceeded(action);
        const nextId = succeeded ? step.next : step.onFailure;
        await emit({
          index,
          stepId: step.id,
          kind: step.kind,
          outcome: threw ? 'exception' : (succeeded ? 'verified' : 'failed'),
          ...(nextId ? { nextStepId: nextId } : {}),
          ...(action?.target?.id ? { targetId: action.target.id } : {}),
          ...(action ? { actionStatus: action.status } : {}),
          beforeFingerprint,
          afterFingerprint,
          browserStateChanged: changed,
          visit,
        });

        if (consecutiveNoProgress >= maxNoProgress) {
          return {
            status: 'stalled',
            completed: false,
            finalStepId: currentId,
            stepsExecuted: index + 1,
            trace,
            validationWarnings: validation.warnings,
          };
        }
        if (!nextId) {
          return {
            status: 'failed',
            completed: false,
            finalStepId: currentId,
            stepsExecuted: index + 1,
            trace,
            validationWarnings: validation.warnings,
          };
        }
        currentId = nextId;
        continue;
      }

      if (step.kind === 'assert') {
        const passed = evaluateTaskPredicate(step.condition, before, inputs);
        const nextId = passed ? step.next : step.onFailure;
        await emit({
          index,
          stepId: step.id,
          kind: step.kind,
          outcome: passed ? 'asserted' : 'assertion-failed',
          ...(nextId ? { nextStepId: nextId } : {}),
          beforeFingerprint,
          afterFingerprint: beforeFingerprint,
          browserStateChanged: false,
          visit,
        });
        if (!nextId) {
          return {
            status: 'failed', completed: false, finalStepId: currentId,
            stepsExecuted: index + 1, trace, validationWarnings: validation.warnings,
          };
        }
        currentId = nextId;
        continue;
      }

      if (step.kind === 'branch') {
        const passed = evaluateTaskPredicate(step.condition, before, inputs);
        const nextId = passed ? step.then : step.else;
        await emit({
          index,
          stepId: step.id,
          kind: step.kind,
          outcome: passed ? 'branch-then' : 'branch-else',
          nextStepId: nextId,
          beforeFingerprint,
          afterFingerprint: beforeFingerprint,
          browserStateChanged: false,
          visit,
        });
        currentId = nextId;
        continue;
      }

      if (step.kind === 'wait') {
        const maxPolls = normalizedPositiveInteger(step.maxPolls, normalizedPositiveInteger(options.waitMaxPolls, 20));
        const pollIntervalMs = Math.max(0, step.pollIntervalMs ?? options.waitPollIntervalMs ?? 100);
        let observed = before;
        let passed = evaluateTaskPredicate(step.condition, observed, inputs);
        for (let poll = 1; !passed && poll < maxPolls; poll += 1) {
          await sleep(pollIntervalMs);
          try {
            observed = await this.engine.refresh();
          } catch {
            break;
          }
          passed = evaluateTaskPredicate(step.condition, observed, inputs);
        }
        const afterFingerprint = interactionSnapshotFingerprint(observed);
        const nextId = passed ? step.next : step.onTimeout;
        await emit({
          index,
          stepId: step.id,
          kind: step.kind,
          outcome: passed ? 'wait-satisfied' : 'wait-timeout',
          ...(nextId ? { nextStepId: nextId } : {}),
          beforeFingerprint,
          afterFingerprint,
          browserStateChanged: beforeFingerprint !== afterFingerprint,
          visit,
        });
        if (!nextId) {
          return {
            status: 'failed', completed: false, finalStepId: currentId,
            stepsExecuted: index + 1, trace, validationWarnings: validation.warnings,
          };
        }
        currentId = nextId;
        continue;
      }

      if (step.kind === 'fail') {
        await emit({
          index,
          stepId: step.id,
          kind: step.kind,
          outcome: 'failed',
          beforeFingerprint,
          afterFingerprint: beforeFingerprint,
          browserStateChanged: false,
          visit,
        });
        return {
          status: 'failed',
          completed: false,
          finalStepId: currentId,
          stepsExecuted: index + 1,
          trace,
          validationWarnings: validation.warnings,
        };
      }

      const passed = step.condition ? evaluateTaskPredicate(step.condition, before, inputs) : true;
      const nextId = passed ? undefined : step.onFailure;
      await emit({
        index,
        stepId: step.id,
        kind: step.kind,
        outcome: passed ? 'completed' : 'completion-condition-failed',
        ...(nextId ? { nextStepId: nextId } : {}),
        beforeFingerprint,
        afterFingerprint: beforeFingerprint,
        browserStateChanged: false,
        visit,
      });
      if (passed) {
        return {
          status: 'completed',
          completed: true,
          finalStepId: currentId,
          stepsExecuted: index + 1,
          trace,
          validationWarnings: validation.warnings,
        };
      }
      if (!nextId) {
        return {
          status: 'failed', completed: false, finalStepId: currentId,
          stepsExecuted: index + 1, trace, validationWarnings: validation.warnings,
        };
      }
      currentId = nextId;
    }

    return {
      status: 'budget-exhausted',
      completed: false,
      finalStepId: currentId,
      stepsExecuted: maxSteps,
      trace,
      validationWarnings: validation.warnings,
    };
  }
}
