import type { InteractionNode } from '../types.js';
import type { CdpIdentityIndex } from './cdpIdentity.js';

/**
 * Attaches stable CDP parent-frame ownership after interaction frame ids have
 * already been mapped into CDP frame ids. Main-frame nodes have no parent.
 */
export function enrichInteractionNodesWithFrameHierarchy(
  nodes: readonly InteractionNode[],
  identities: Pick<CdpIdentityIndex, 'frameToParentFrame'>,
): InteractionNode[] {
  return nodes.map((node) => ({
    ...node,
    parentFrameId: identities.frameToParentFrame.get(node.frameId),
  }));
}

export function isDirectChildFrame(
  child: InteractionNode,
  parent: InteractionNode,
): boolean {
  return child.frameId !== parent.frameId && child.parentFrameId === parent.frameId;
}

export function isDirectParentFrame(
  parent: InteractionNode,
  child: InteractionNode,
): boolean {
  return isDirectChildFrame(child, parent);
}
