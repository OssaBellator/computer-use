import { snapshotInteractiveDom, type SnapshotFrameLike, type SnapshotPageLike } from './domSnapshot.js';
import type { InteractionNode } from '../types.js';

export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
}

export interface SnapshotFrameDescriptor {
  interactionFrameId: string;
  parentInteractionFrameId?: string;
  url?: string;
  name?: string;
  siblingIndex: number;
}

type SnapshotFrameWithMetadata = SnapshotFrameLike & {
  url?(): string;
  name?(): string;
  parentFrame?(): SnapshotFrameLike | null;
};

export function describeSnapshotFrames(page: SnapshotPageLike): SnapshotFrameDescriptor[] {
  const frames = page.frames() as SnapshotFrameWithMetadata[];
  const ids = new Map(frames.map((frame, index) => [frame, index === 0 ? 'main' : `frame-${index}`]));
  const siblingCounts = new Map<string, number>();
  return frames.map((frame) => {
    const parent = frame.parentFrame?.() as SnapshotFrameWithMetadata | null | undefined;
    const parentInteractionFrameId = parent ? ids.get(parent) : undefined;
    const bucket = parentInteractionFrameId ?? '<root>';
    const siblingIndex = siblingCounts.get(bucket) ?? 0;
    siblingCounts.set(bucket, siblingIndex + 1);
    return {
      interactionFrameId: ids.get(frame)!,
      parentInteractionFrameId,
      url: frame.url?.(),
      name: frame.name?.(),
      siblingIndex,
    };
  });
}

interface CdpDomNode {
  nodeId: number;
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  attributes?: string[];
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
  contentDocument?: CdpDomNode;
  frameId?: string;
}

interface CdpAxValue { value?: unknown; }
interface CdpAxNode {
  nodeId: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: CdpAxValue;
  name?: CdpAxValue;
  value?: CdpAxValue;
}

interface RawCdpFrame {
  id: string;
  parentId?: string;
  url?: string;
  name?: string;
}
interface RawCdpFrameTree {
  frame: RawCdpFrame;
  childFrames?: RawCdpFrameTree[];
}

export interface CdpFrameDescriptor {
  frameId: string;
  parentFrameId?: string;
  url?: string;
  name?: string;
  siblingIndex: number;
}

export interface CdpNodeIdentity {
  nodeId: number;
  backendNodeId: number;
  frameId?: string;
  path: string;
  nodeName: string;
  attributes: Record<string, string>;
  axNodeId?: string;
  axIgnored?: boolean;
  role?: string;
  name?: string;
  value?: string;
}

export class CdpIdentityIndex {
  readonly byBackendNodeId = new Map<number, CdpNodeIdentity>();
  readonly byPath = new Map<string, CdpNodeIdentity[]>();
  readonly frames = new Map<string, CdpFrameDescriptor>();

  constructor(readonly mainFrameId?: string) {}

  add(identity: CdpNodeIdentity): void {
    this.byBackendNodeId.set(identity.backendNodeId, identity);
    const bucket = this.byPath.get(identity.path) ?? [];
    bucket.push(identity);
    this.byPath.set(identity.path, bucket);
  }

  addFrame(frame: CdpFrameDescriptor): void {
    this.frames.set(frame.frameId, frame);
  }

  candidatesForPath(path: string): readonly CdpNodeIdentity[] {
    return this.byPath.get(path) ?? [];
  }
}

function attributesObject(attributes: readonly string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i + 1 < (attributes?.length ?? 0); i += 2) result[attributes![i]] = attributes![i + 1];
  return result;
}

function stringValue(value: CdpAxValue | undefined): string | undefined {
  if (value?.value === undefined || value.value === null) return undefined;
  return String(value.value);
}

function elementSegment(node: CdpDomNode, siblings: readonly CdpDomNode[]): string {
  let index = 0;
  for (const sibling of siblings) {
    if (sibling.nodeType === 1 && sibling.nodeName === node.nodeName) index += 1;
    if (sibling === node) break;
  }
  return `${node.nodeName.toLowerCase()}:nth-of-type(${Math.max(1, index)})`;
}

function addFrameTree(index: CdpIdentityIndex, tree: RawCdpFrameTree, siblingIndex = 0): void {
  index.addFrame({
    frameId: tree.frame.id,
    parentFrameId: tree.frame.parentId,
    url: tree.frame.url,
    name: tree.frame.name,
    siblingIndex,
  });
  (tree.childFrames ?? []).forEach((child, childIndex) => addFrameTree(index, child, childIndex));
}

/** Capture stable DOM backend identities and fuse them with Accessibility nodes. */
export async function captureCdpIdentityIndex(session: CdpSessionLike): Promise<CdpIdentityIndex> {
  const [documentResult, axResult, frameTreeResult] = await Promise.all([
    session.send('DOM.getDocument', { depth: -1, pierce: true }),
    session.send('Accessibility.getFullAXTree'),
    session.send('Page.getFrameTree'),
  ]);

  const root = documentResult.root as CdpDomNode;
  const axNodes = (axResult.nodes ?? []) as CdpAxNode[];
  const frameTree = frameTreeResult.frameTree as RawCdpFrameTree | undefined;
  const mainFrameId = frameTree?.frame?.id;
  const axByBackend = new Map<number, CdpAxNode>();
  for (const ax of axNodes) {
    if (typeof ax.backendDOMNodeId === 'number' && !axByBackend.has(ax.backendDOMNodeId)) {
      axByBackend.set(ax.backendDOMNodeId, ax);
    }
  }

  const index = new CdpIdentityIndex(mainFrameId);
  if (frameTree) addFrameTree(index, frameTree);
  const visited = new Set<number>();

  function walk(node: CdpDomNode, path: readonly string[], siblings: readonly CdpDomNode[], frameId: string | undefined): void {
    if (visited.has(node.nodeId)) return;
    visited.add(node.nodeId);

    // `frameId` on an IFRAME element identifies its content frame, not the frame
    // that owns the iframe element itself. Keep the owning frame for this node.
    const nodeFrameId = frameId;
    let nextPath = [...path];
    if (node.nodeType === 1) {
      const isDocumentElement = node.nodeName === 'HTML' && path.length === 0;
      if (!isDocumentElement) nextPath.push(elementSegment(node, siblings));
      const ax = axByBackend.get(node.backendNodeId);
      index.add({
        nodeId: node.nodeId,
        backendNodeId: node.backendNodeId,
        frameId: nodeFrameId,
        path: nextPath.join(' > '),
        nodeName: node.nodeName.toLowerCase(),
        attributes: attributesObject(node.attributes),
        axNodeId: ax?.nodeId,
        axIgnored: ax?.ignored,
        role: stringValue(ax?.role),
        name: stringValue(ax?.name),
        value: stringValue(ax?.value),
      });
    }

    const children = node.children ?? [];
    for (const child of children) walk(child, nextPath, children, nodeFrameId);
    for (const shadowRoot of node.shadowRoots ?? []) {
      const shadowChildren = shadowRoot.children ?? [];
      const shadowPath = [...nextPath, '::shadow'];
      for (const child of shadowChildren) walk(child, shadowPath, shadowChildren, nodeFrameId);
    }
    if (node.contentDocument) {
      const contentFrameId = node.contentDocument.frameId ?? node.frameId ?? nodeFrameId;
      const contentChildren = node.contentDocument.children ?? [];
      for (const child of contentChildren) walk(child, [], contentChildren, contentFrameId);
    }
  }

  const rootChildren = root.children ?? [];
  for (const child of rootChildren) walk(child, [], rootChildren, mainFrameId);
  return index;
}

function localNodePath(node: InteractionNode): string {
  const prefix = `${node.frameId}:`;
  return node.id.startsWith(prefix) ? node.id.slice(prefix.length) : node.id;
}

export interface CdpIdentityEnrichmentOptions {
  frameIdMap?: Readonly<Record<string, string>>;
}

/** Maps structural snapshot frame labels to CDP frame IDs without relying on DOM-path uniqueness. */
export function buildInteractionFrameIdMap(
  interactionFrames: readonly SnapshotFrameDescriptor[],
  identities: CdpIdentityIndex,
): Record<string, string> {
  const result: Record<string, string> = {};
  const used = new Set<string>();
  const main = interactionFrames.find((frame) => frame.interactionFrameId === 'main');
  if (main && identities.mainFrameId) {
    result[main.interactionFrameId] = identities.mainFrameId;
    used.add(identities.mainFrameId);
  }

  const pending = interactionFrames.filter((frame) => frame.interactionFrameId !== 'main');
  let progressed = true;
  while (pending.length && progressed) {
    progressed = false;
    for (let i = 0; i < pending.length;) {
      const frame = pending[i];
      const parentCdpId = frame.parentInteractionFrameId ? result[frame.parentInteractionFrameId] : identities.mainFrameId;
      if (!parentCdpId) { i += 1; continue; }
      const candidates = [...identities.frames.values()].filter((candidate) =>
        candidate.parentFrameId === parentCdpId && !used.has(candidate.frameId),
      );
      let matched: CdpFrameDescriptor | undefined;
      const byBoth = candidates.filter((candidate) =>
        !!frame.name && candidate.name === frame.name && !!frame.url && candidate.url === frame.url,
      );
      if (byBoth.length === 1) matched = byBoth[0];
      if (!matched && frame.name) {
        const byName = candidates.filter((candidate) => candidate.name === frame.name);
        if (byName.length === 1) matched = byName[0];
      }
      if (!matched && frame.url) {
        const byUrl = candidates.filter((candidate) => candidate.url === frame.url);
        if (byUrl.length === 1) matched = byUrl[0];
      }
      if (!matched) matched = candidates.find((candidate) => candidate.siblingIndex === frame.siblingIndex);
      if (!matched) { i += 1; continue; }
      result[frame.interactionFrameId] = matched.frameId;
      used.add(matched.frameId);
      pending.splice(i, 1);
      progressed = true;
    }
  }
  return result;
}

export function enrichInteractionNodesWithCdpIdentity(
  nodes: readonly InteractionNode[],
  identities: CdpIdentityIndex,
  options: CdpIdentityEnrichmentOptions = {},
): InteractionNode[] {
  return nodes.map((node) => {
    const candidates = identities.candidatesForPath(localNodePath(node));
    const expectedFrameId = options.frameIdMap?.[node.frameId] ??
      (node.frameId === 'main' ? identities.mainFrameId : undefined);
    const framed = expectedFrameId ? candidates.filter((candidate) => candidate.frameId === expectedFrameId) : candidates;
    const identity = framed.length === 1 ? framed[0] : undefined;
    if (!identity) return { ...node };
    return {
      ...node,
      backendNodeId: identity.backendNodeId,
      axNodeId: identity.axNodeId,
      role: identity.role ?? node.role,
      name: identity.name ?? node.name,
      value: identity.value ?? node.value,
    };
  });
}

/** One-shot semantic snapshot with structural frame resolution and stable CDP/AX identity enrichment. */
export async function snapshotInteractiveDomWithCdpIdentity(
  page: SnapshotPageLike,
  session: CdpSessionLike,
): Promise<InteractionNode[]> {
  const [nodes, identities] = await Promise.all([
    snapshotInteractiveDom(page),
    captureCdpIdentityIndex(session),
  ]);
  const frameIdMap = buildInteractionFrameIdMap(describeSnapshotFrames(page), identities);
  return enrichInteractionNodesWithCdpIdentity(nodes, identities, { frameIdMap });
}
