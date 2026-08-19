import type { BrowserStateSnapshot } from '../browser/browserState.js';
import type { BrowserDialogState } from '../browser/dialogController.js';
import type { BrowserTargetSummary } from '../browser/targetController.js';
import { resolveInteractionTargetDetailed } from '../model/targetResolver.js';
import type { InteractionNode } from '../types.js';
import type { ProgramText, TaskPredicate } from './taskProgram.js';
import type { TaskRuntimeEngine } from './taskRuntimeContracts.js';

export interface TaskObservation {
  nodes: InteractionNode[];
  browser?: BrowserStateSnapshot;
  dialog?: BrowserDialogState;
  targets?: BrowserTargetSummary;
  fingerprint: string;
}

export function resolveProgramText(
  text: ProgramText,
  inputs: Readonly<Record<string, string>>,
): string {
  return typeof text === 'string' ? text : inputs[text.input]!;
}

function matchesNode(
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
  if (state.valueIncludes !== undefined &&
      !node.value?.includes(resolveProgramText(state.valueIncludes, inputs))) return false;
  return true;
}

function matchesBrowser(
  state: Extract<TaskPredicate, { kind: 'browser' }>['state'],
  browser: BrowserStateSnapshot | undefined,
  inputs: Readonly<Record<string, string>>,
): boolean {
  if (!browser) return false;
  if (state.url !== undefined && browser.url !== resolveProgramText(state.url, inputs)) return false;
  if (state.urlIncludes !== undefined &&
      !browser.url.includes(resolveProgramText(state.urlIncludes, inputs))) return false;
  if (state.origin !== undefined && browser.origin !== resolveProgramText(state.origin, inputs)) return false;
  if (state.title !== undefined && browser.title !== resolveProgramText(state.title, inputs)) return false;
  if (state.titleIncludes !== undefined &&
      !browser.title.includes(resolveProgramText(state.titleIncludes, inputs))) return false;
  if (state.readyState !== undefined && browser.readyState !== state.readyState) return false;
  if (state.historyLength !== undefined && browser.historyLength !== state.historyLength) return false;
  return state.historyLengthAtLeast === undefined || browser.historyLength >= state.historyLengthAtLeast;
}

function matchesDialog(
  state: Extract<TaskPredicate, { kind: 'dialog' }>['state'],
  dialog: BrowserDialogState | undefined,
): boolean {
  const open = dialog !== undefined;
  if (state.open !== undefined && open !== state.open) return false;
  if (state.type !== undefined && dialog?.type !== state.type) return false;
  return state.open === false || dialog !== undefined;
}

function matchesTargets(
  state: Extract<TaskPredicate, { kind: 'targets' }>['state'],
  targets: BrowserTargetSummary | undefined,
): boolean {
  if (!targets) return false;
  if (state.pageCountAtLeast !== undefined && targets.pages < state.pageCountAtLeast) return false;
  if (state.unattachedPageCountAtLeast !== undefined &&
      targets.unattachedPages < state.unattachedPageCountAtLeast) return false;
  return true;
}

export function evaluateTaskPredicate(
  predicate: TaskPredicate,
  nodes: readonly InteractionNode[],
  inputs: Readonly<Record<string, string>> = {},
  browserState?: BrowserStateSnapshot,
  dialogState?: BrowserDialogState,
  targetState?: BrowserTargetSummary,
): boolean {
  switch (predicate.kind) {
    case 'exists': {
      const resolution = resolveInteractionTargetDetailed(nodes, predicate.target);
      return resolution.target !== null && (!predicate.unambiguous || !resolution.ambiguous);
    }
    case 'state': {
      const resolution = resolveInteractionTargetDetailed(nodes, predicate.target);
      return !!resolution.target && (!predicate.unambiguous || !resolution.ambiguous) &&
        matchesNode(resolution.target, predicate.state, inputs);
    }
    case 'browser': return matchesBrowser(predicate.state, browserState, inputs);
    case 'dialog': return matchesDialog(predicate.state, dialogState);
    case 'targets': return matchesTargets(predicate.state, targetState);
    case 'all':
      return predicate.predicates.every((nested) =>
        evaluateTaskPredicate(nested, nodes, inputs, browserState, dialogState, targetState));
    case 'any':
      return predicate.predicates.some((nested) =>
        evaluateTaskPredicate(nested, nodes, inputs, browserState, dialogState, targetState));
    case 'not':
      return !evaluateTaskPredicate(predicate.predicate, nodes, inputs, browserState, dialogState, targetState);
  }
}

function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

const field = (value: unknown) => value === undefined ? '' : String(value);

/** Semantic fingerprint used for progress detection; traces retain only the resulting hash. */
export function interactionSnapshotFingerprint(nodes: readonly InteractionNode[]): string {
  const stable = [...nodes]
    .filter((node) => node.id !== '@cursor')
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((node) => [
      node.id, node.frameId, node.role ?? '', node.name ?? '', node.value ?? '',
      field(node.focused), field(node.disabled), field(node.expanded), field(node.checked),
      field(node.selected), field(node.pressed), node.activeDescendantId ?? '',
      field(node.viewportVisible), field(node.mainViewportVisible),
    ].join('\u001f'))
    .join('\u001e');
  return hashString(stable);
}

/** Include browser/modal/target identity so non-DOM lifecycle changes count as progress. */
export function taskObservationFingerprint(
  nodes: readonly InteractionNode[],
  browser?: BrowserStateSnapshot,
  dialog?: BrowserDialogState,
  targets?: BrowserTargetSummary,
): string {
  const browserValue = browser
    ? [browser.url, browser.origin, browser.title, browser.readyState,
        String(browser.historyLength), String(browser.timeOrigin)].join('\u001f')
    : '';
  const dialogValue = dialog ? `${dialog.type}\u001f${dialog.sequence}` : '';
  const targetValue = targets
    ? [targets.total, targets.pages, targets.unattachedPages,
        targets.latestPage?.targetId ?? '', targets.latestPage?.sequence ?? '',
        targets.latestUnattachedPage?.targetId ?? '', targets.latestUnattachedPage?.sequence ?? ''].join('\u001f')
    : '';
  return hashString(`${interactionSnapshotFingerprint(nodes)}\u001d${browserValue}\u001d${dialogValue}\u001d${targetValue}`);
}

export async function observeTaskEngine(engine: TaskRuntimeEngine): Promise<TaskObservation> {
  let nodes: InteractionNode[] | undefined;
  let browser: BrowserStateSnapshot | undefined;
  let dialog: BrowserDialogState | undefined;
  let targets: BrowserTargetSummary | undefined;
  try { nodes = await engine.refresh(); } catch {}
  try { browser = await engine.browserState?.(); } catch {}
  try { dialog = engine.dialogState?.(); } catch {}
  try { targets = engine.targetState?.(); } catch {}
  if (nodes === undefined && browser === undefined && dialog === undefined && targets === undefined) {
    throw new Error('No browser observation channel is currently available');
  }
  const normalizedNodes = nodes ?? [];
  return {
    nodes: normalizedNodes,
    browser,
    dialog,
    targets,
    fingerprint: taskObservationFingerprint(normalizedNodes, browser, dialog, targets),
  };
}
