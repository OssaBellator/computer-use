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

export interface TargetResolution {
  target: InteractionNode | null;
  candidates: InteractionNode[];
  equallyPreferred: InteractionNode[];
  ambiguous: boolean;
}

function isVisible(node: InteractionNode): boolean {
  return node.mainViewportVisible !== false && node.viewportVisible !== false &&
    (node.mainViewportVisibleRect !== undefined || node.visibleRect !== undefined ||
      node.mainViewportRect !== undefined || node.rect !== undefined);
}

function semanticRankEquals(a: InteractionNode, b: InteractionNode): boolean {
  return isVisible(a) === isVisible(b) &&
    a.disabled === b.disabled &&
    Math.abs(a.interactionConfidence - b.interactionConfidence) <= Number.EPSILON;
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

/**
 * Returns the deterministic target plus all matches sharing the same semantic
 * rank before the final stable-id tie break. Callers can surface ambiguity
 * instead of silently pretending an arbitrary DOM identity was semantically unique.
 */
export function resolveInteractionTargetDetailed(
  nodes: readonly InteractionNode[],
  query: TargetQuery | string,
): TargetResolution {
  let candidates: InteractionNode[];
  if (typeof query === 'string') {
    const direct = findInteractionTargets(nodes, { id: query });
    candidates = direct.length ? direct : findInteractionTargets(nodes, { name: query });
  } else {
    candidates = findInteractionTargets(nodes, query);
  }
  const target = candidates[0] ?? null;
  const equallyPreferred = target
    ? candidates.filter((candidate) => semanticRankEquals(target, candidate))
    : [];
  return {
    target,
    candidates,
    equallyPreferred,
    ambiguous: equallyPreferred.length > 1,
  };
}

/** Returns a deterministic best match; inspect resolveInteractionTargetDetailed for ambiguity. */
export function resolveInteractionTarget(
  nodes: readonly InteractionNode[],
  query: TargetQuery | string,
): InteractionNode | null {
  return resolveInteractionTargetDetailed(nodes, query).target;
}
