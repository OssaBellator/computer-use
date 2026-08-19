import type { InteractionEdge, InteractionNode } from '../types.js';

export function resolveActiveDescendant(
  nodes: readonly InteractionNode[],
  owner: InteractionNode,
): InteractionNode | undefined {
  const structuralId = owner.activeDescendantStructuralId;
  if (!structuralId) return undefined;
  return nodes.find((node) =>
    node.frameId === owner.frameId &&
    (node.structuralId === structuralId || node.id === structuralId),
  );
}

export function focusedCompositeState(
  nodes: readonly InteractionNode[],
): { owner: InteractionNode; active: InteractionNode } | null {
  const owner = nodes.find((node) => node.focused && !!node.activeDescendantStructuralId);
  if (!owner) return null;
  const active = resolveActiveDescendant(nodes, owner);
  return active ? { owner, active } : null;
}

/**
 * Adds zero-input bridges between real DOM focus and logical active-descendant
 * state. These edges exist only while the composite owner is actually focused.
 */
export function buildCompositeAnchorEdges(
  nodes: readonly InteractionNode[],
): InteractionEdge[] {
  const state = focusedCompositeState(nodes);
  if (!state) return [];
  const { owner, active } = state;
  return [
    {
      from: owner.id,
      to: active.id,
      kind: 'state-anchor',
      estimatedTimeMs: 0,
      failureProbability: 0,
      uncertaintyCost: 0,
    },
    {
      from: active.id,
      to: owner.id,
      kind: 'state-anchor',
      estimatedTimeMs: 0,
      failureProbability: 0,
      uncertaintyCost: 0,
    },
  ];
}

export function compositeAnchorIsCurrent(
  nodes: readonly InteractionNode[],
  fromId: string,
  toId: string,
): boolean {
  const state = focusedCompositeState(nodes);
  if (!state) return false;
  return (
    (state.owner.id === fromId && state.active.id === toId) ||
    (state.active.id === fromId && state.owner.id === toId)
  );
}
