import type { InteractionNode } from '../types.js';

export interface SnapshotDelta {
  added: string[];
  removed: string[];
  focusedBefore: string | null;
  focusedAfter: string | null;
  changedValues: Array<{ id: string; before?: string; after?: string }>;
}

export function diffSnapshots(
  before: readonly InteractionNode[],
  after: readonly InteractionNode[],
): SnapshotDelta {
  const a = new Map(before.map((node) => [node.id, node]));
  const b = new Map(after.map((node) => [node.id, node]));
  const added = [...b.keys()].filter((id) => !a.has(id)).sort();
  const removed = [...a.keys()].filter((id) => !b.has(id)).sort();
  const changedValues: SnapshotDelta['changedValues'] = [];

  for (const [id, beforeNode] of a) {
    const afterNode = b.get(id);
    if (afterNode && beforeNode.value !== afterNode.value) {
      changedValues.push({ id, before: beforeNode.value, after: afterNode.value });
    }
  }

  return {
    added,
    removed,
    focusedBefore: before.find((node) => node.focused)?.id ?? null,
    focusedAfter: after.find((node) => node.focused)?.id ?? null,
    changedValues,
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
