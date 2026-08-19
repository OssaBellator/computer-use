import type { InteractionNode } from '../types.js';

export type ObservableStateField =
  | 'disabled'
  | 'expanded'
  | 'checked'
  | 'selected'
  | 'pressed'
  | 'activeDescendantId';

export interface StateChange {
  id: string;
  field: ObservableStateField;
  before: unknown;
  after: unknown;
}

export interface SnapshotDelta {
  added: string[];
  removed: string[];
  focusedBefore: string | null;
  focusedAfter: string | null;
  changedValues: Array<{ id: string; before?: string; after?: string }>;
  changedStates: StateChange[];
}

const STATE_FIELDS: readonly ObservableStateField[] = [
  'disabled', 'expanded', 'checked', 'selected', 'pressed', 'activeDescendantId',
];

export function diffSnapshots(
  before: readonly InteractionNode[],
  after: readonly InteractionNode[],
): SnapshotDelta {
  const a = new Map(before.map((node) => [node.id, node]));
  const b = new Map(after.map((node) => [node.id, node]));
  const added = [...b.keys()].filter((id) => !a.has(id)).sort();
  const removed = [...a.keys()].filter((id) => !b.has(id)).sort();
  const changedValues: SnapshotDelta['changedValues'] = [];
  const changedStates: StateChange[] = [];

  for (const [id, beforeNode] of a) {
    const afterNode = b.get(id);
    if (!afterNode) continue;
    if (beforeNode.value !== afterNode.value) {
      changedValues.push({ id, before: beforeNode.value, after: afterNode.value });
    }
    for (const field of STATE_FIELDS) {
      if (beforeNode[field] !== afterNode[field]) {
        changedStates.push({ id, field, before: beforeNode[field], after: afterNode[field] });
      }
    }
  }

  return {
    added,
    removed,
    focusedBefore: before.find((node) => node.focused)?.id ?? null,
    focusedAfter: after.find((node) => node.focused)?.id ?? null,
    changedValues,
    changedStates,
  };
}

export function focusTransitionSucceeded(delta: SnapshotDelta, expectedTargetId: string): boolean {
  return delta.focusedAfter === expectedTargetId && delta.focusedAfter !== delta.focusedBefore;
}

export function valueChangeSucceeded(
  delta: SnapshotDelta,
  targetId: string,
  expectedValue?: string,
): boolean {
  const change = delta.changedValues.find((item) => item.id === targetId);
  return !!change && (expectedValue === undefined || change.after === expectedValue);
}

export function stateChangeSucceeded(
  delta: SnapshotDelta,
  targetId: string,
  field: ObservableStateField,
  expectedValue?: unknown,
): boolean {
  const change = delta.changedStates.find((item) => item.id === targetId && item.field === field);
  return !!change && (arguments.length < 4 || Object.is(change.after, expectedValue));
}
