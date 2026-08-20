import type { InteractionNode } from '../types.js';
import type { SnapshotFrameDescriptor } from './cdpIdentity.js';

export interface InteractionFrameHierarchy {
  frameToParentFrame: ReadonlyMap<string, string>;
}

export function buildInteractionFrameHierarchy(
  frames: readonly SnapshotFrameDescriptor[],
): InteractionFrameHierarchy {
  const frameToParentFrame = new Map<string, string>();
  for (const frame of frames) {
    if (frame.parentInteractionFrameId) {
      frameToParentFrame.set(frame.interactionFrameId, frame.parentInteractionFrameId);
    }
  }
  return { frameToParentFrame };
}

/** Attaches parent ownership in the same interaction-frame id space as node.frameId. */
export function enrichInteractionNodesWithFrameHierarchy(
  nodes: readonly InteractionNode[],
  hierarchy: InteractionFrameHierarchy,
): InteractionNode[] {
  return nodes.map((node) => ({
    ...node,
    parentFrameId: hierarchy.frameToParentFrame.get(node.frameId),
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
