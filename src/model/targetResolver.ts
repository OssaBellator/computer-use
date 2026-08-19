import type { InteractionCapability, InteractionNode } from '../types.js';

export interface TargetQuery {
  id?: string;
  backendNodeId?: number;
  frameId?: string;
  role?: string;
  name?: string;
  nameIncludes?: string;
  capability?: InteractionCapability;
  visible?: boolean;
  enabled?: boolean;
}

function isVisible(node: InteractionNode): boolean {
  return node.mainViewportVisible !== false && node.viewportVisible !== false &&
    (node.mainViewportVisibleRect !== undefined || node.visibleRect !== undefined ||
      node.mainViewportRect !== undefined || node.rect !== undefined);
}

export function findInteractionTargets(
  nodes: readonly InteractionNode[],
  query: TargetQuery | string,
): InteractionNode[] {
  const normalized: TargetQuery = typeof query === 'string' ? { id: query } : query;
  const role = normalized.role?.toLowerCase();
  const name = normalized.name;
  const nameIncludes = normalized.nameIncludes?.toLowerCase();

  return nodes
    .filter((node) => {
      if (node.id === '@cursor') return false;
      if (normalized.id && node.id !== normalized.id && node.structuralId !== normalized.id) return false;
      if (normalized.backendNodeId !== undefined && node.backendNodeId !== normalized.backendNodeId) return false;
      if (normalized.frameId && node.frameId !== normalized.frameId) return false;
      if (role && node.role?.toLowerCase() !== role) return false;
      if (name !== undefined && node.name !== name) return false;
      if (nameIncludes && !node.name?.toLowerCase().includes(nameIncludes)) return false;
      if (normalized.capability && !node.capabilities.includes(normalized.capability)) return false;
      if (normalized.visible !== undefined && isVisible(node) !== normalized.visible) return false;
      if (normalized.enabled !== undefined && (!node.disabled) !== normalized.enabled) return false;
      return true;
    })
    .sort((a, b) => {
      const visibleDelta = Number(isVisible(b)) - Number(isVisible(a));
      if (visibleDelta) return visibleDelta;
      const enabledDelta = Number(!b.disabled) - Number(!a.disabled);
      if (enabledDelta) return enabledDelta;
      const confidenceDelta = b.interactionConfidence - a.interactionConfidence;
      if (confidenceDelta) return confidenceDelta;
      return a.id.localeCompare(b.id);
    });
}

/** Returns a deterministic best match; callers can inspect findInteractionTargets for ambiguity. */
export function resolveInteractionTarget(
  nodes: readonly InteractionNode[],
  query: TargetQuery | string,
): InteractionNode | null {
  if (typeof query === 'string') {
    const direct = findInteractionTargets(nodes, { id: query });
    if (direct.length) return direct[0];
    return findInteractionTargets(nodes, { name: query })[0] ?? null;
  }
  return findInteractionTargets(nodes, query)[0] ?? null;
}
