import type { InteractionNode, Point, Rect } from '../types.js';
import { snapshotInteractiveDom, type SnapshotPageLike } from './domSnapshot.js';
import {
  snapshotDocumentContent,
  type DocumentContentOptions,
  type DocumentContentSnapshot,
} from './documentContent.js';
import {
  buildInteractionFrameIdMap,
  captureCdpIdentityIndex,
  describeSnapshotFrames,
  enrichInteractionNodesWithCdpIdentity,
  stabilizeInteractionNodeIds,
  type CdpIdentityIndex,
  type CdpSessionLike,
} from './cdpIdentity.js';
import {
  captureCdpViewportGeometry,
  enrichInteractionNodesWithCdpGeometry,
  findCdpHitTestedTargetPoint,
  pointHitsCdpInteractionNode,
} from './cdpGeometry.js';
import {
  buildInteractionFrameHierarchy,
  enrichInteractionNodesWithFrameHierarchy,
} from './frameHierarchy.js';

export interface BrowserInteractionObserver {
  snapshot(): Promise<readonly InteractionNode[]>;
  /** Optional bounded structured reading model for non-interactive document content. */
  documentContent?(options?: DocumentContentOptions): Promise<DocumentContentSnapshot>;
  targetPoint(node: InteractionNode): Promise<Point | null>;
  pointStillTargets(node: InteractionNode, point: Point): Promise<boolean>;
  viewportRect?(): Promise<Rect>;
}

type RefreshableSnapshotPage = SnapshotPageLike & { refresh?: () => Promise<void> };

/**
 * Stateful CDP-backed observer that composes DOM semantics, stable backend/AX
 * identity, frame ownership, normalized geometry, paint-order hit tests, and a
 * bounded structured reading model for non-interactive page content.
 */
export class CdpInteractionObserver implements BrowserInteractionObserver {
  private identities?: CdpIdentityIndex;

  constructor(
    private readonly page: SnapshotPageLike,
    private readonly session: CdpSessionLike,
  ) {}

  get identityIndex(): CdpIdentityIndex | undefined {
    return this.identities;
  }

  async snapshot(): Promise<InteractionNode[]> {
    await (this.page as RefreshableSnapshotPage).refresh?.();
    const frameDescriptors = describeSnapshotFrames(this.page);
    const [raw, identities] = await Promise.all([
      snapshotInteractiveDom(this.page),
      captureCdpIdentityIndex(this.session),
    ]);
    const frameIdMap = buildInteractionFrameIdMap(frameDescriptors, identities);
    const enriched = enrichInteractionNodesWithCdpIdentity(raw, identities, { frameIdMap });
    const stable = stabilizeInteractionNodeIds(enriched);
    const withHierarchy = enrichInteractionNodesWithFrameHierarchy(
      stable,
      buildInteractionFrameHierarchy(frameDescriptors),
    );
    const normalized = await enrichInteractionNodesWithCdpGeometry(withHierarchy, this.session);
    this.identities = identities;
    return normalized;
  }

  async documentContent(options: DocumentContentOptions = {}): Promise<DocumentContentSnapshot> {
    await (this.page as RefreshableSnapshotPage).refresh?.();
    return snapshotDocumentContent(this.page, options);
  }

  async targetPoint(node: InteractionNode): Promise<Point | null> {
    if (!this.identities) await this.snapshot();
    return findCdpHitTestedTargetPoint(this.session, this.identities!, node);
  }

  async pointStillTargets(node: InteractionNode, point: Point): Promise<boolean> {
    if (!this.identities) await this.snapshot();
    let result = await pointHitsCdpInteractionNode(this.session, this.identities!, node, point);
    if (result.hit) return true;
    this.identities = await captureCdpIdentityIndex(this.session);
    result = await pointHitsCdpInteractionNode(this.session, this.identities, node, point);
    return result.hit;
  }

  async viewportRect(): Promise<Rect> {
    return (await captureCdpViewportGeometry(this.session)).viewportRect;
  }
}
