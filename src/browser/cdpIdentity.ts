import type { InteractionNode } from '../types.js';

export interface CdpSessionLike {
  send(method: string, params?: Record<string, unknown>): Promise<any>;
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

interface CdpAxValue {
  value?: unknown;
}

interface CdpAxNode {
  nodeId: string;
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: CdpAxValue;
  name?: CdpAxValue;
  value?: CdpAxValue;
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

  constructor(readonly mainFrameId?: string) {}

  add(identity: CdpNodeIdentity): void {
    this.byBackendNodeId.set(identity.backendNodeId, identity);
    const bucket = this.byPath.get(identity.path) ?? [];
    bucket.push(identity);
    this.byPath.set(identity.path, bucket);
  }

  candidatesForPath(path: string): readonly CdpNodeIdentity[] {
    return this.byPath.get(path) ?? [];
  }
}

function attributesObject(attributes: readonly string[] | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (let i = 0; i + 1 < (attributes?.length ?? 0); i += 2) {
    result[attributes![i]] = attributes![i + 1];
  }
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

/**
 * Capture stable DOM backend identities and fuse them with Accessibility nodes.
 * Paths intentionally mirror domSnapshot.ts, including explicit ::shadow markers.
 */
export async function captureCdpIdentityIndex(session: CdpSessionLike): Promise<CdpIdentityIndex> {
  const [documentResult, axResult, frameTreeResult] = await Promise.all([
    session.send('DOM.getDocument', { depth: -1, pierce: true }),
    session.send('Accessibility.getFullAXTree'),
    session.send('Page.getFrameTree'),
  ]);

  const root = documentResult.root as CdpDomNode;
  const axNodes = (axResult.nodes ?? []) as CdpAxNode[];
  const mainFrameId = frameTreeResult.frameTree?.frame?.id as string | undefined;
  const axByBackend = new Map<number, CdpAxNode>();
  for (const ax of axNodes) {
    if (typeof ax.backendDOMNodeId === 'number' && !axByBackend.has(ax.backendDOMNodeId)) {
      axByBackend.set(ax.backendDOMNodeId, ax);
    }
  }

  const index = new CdpIdentityIndex(mainFrameId);
  const visited = new Set<number>();

  function walk(
    node: CdpDomNode,
    path: readonly string[],
    siblings: readonly CdpDomNode[],
    frameId: string | undefined,
  ): void {
    if (visited.has(node.nodeId)) return;
    visited.add(node.nodeId);

    const nodeFrameId = node.frameId ?? frameId;
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
  /** Maps interaction frame IDs (for example frame-1) to actual CDP frame IDs. */
  frameIdMap?: Readonly<Record<string, string>>;
}

/**
 * Enrich current interaction nodes with stable backend/AX IDs. Ambiguous path
 * matches are deliberately left untouched unless a frame mapping resolves them.
 */
export function enrichInteractionNodesWithCdpIdentity(
  nodes: readonly InteractionNode[],
  identities: CdpIdentityIndex,
  options: CdpIdentityEnrichmentOptions = {},
): InteractionNode[] {
  return nodes.map((node) => {
    const candidates = identities.candidatesForPath(localNodePath(node));
    const expectedFrameId = options.frameIdMap?.[node.frameId] ??
      (node.frameId === 'main' ? identities.mainFrameId : undefined);
    const framed = expectedFrameId
      ? candidates.filter((candidate) => candidate.frameId === expectedFrameId)
      : candidates;
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
