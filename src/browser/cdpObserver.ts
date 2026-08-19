import type { InteractionNode, Point } from '../types.js';
import { snapshotInteractiveDom, type SnapshotPageLike } from './domSnapshot.js';
import {
  buildInteractionFrameIdMap,
  captureCdpIdentityIndex,
  describeSnapshotFrames,
  enrichInteractionNodesWithCdpIdentity,
  type CdpIdentityIndex,
  type CdpSessionLike,
} from './cdpIdentity.js';
import {
  enrichInteractionNodesWithCdpGeometry,
  findCdpHitTestedTargetPoint,
  pointHitsCdpInteractionNode,
} from './cdpGeometry.js';

export interface BrowserInteractionObserver {
  snapshot(): Promise<readonly InteractionNode[]>;
  targetPoint(node: InteractionNode): Promise<Point | null>;
  pointStillTargets(node: InteractionNode, point: Point): Promise<boolean>;
}

/**
 * Stateful CDP-backed observer that composes DOM semantics, stable backend/AX
 * identity, frame disambiguation, normalized geometry, and paint-order hit tests.
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
    const [raw, identities] = await Promise.all([
      snapshotInteractiveDom(this.page),
      captureCdpIdentityIndex(this.session),
    ]);
    const frameIdMap = buildInteractionFrameIdMap(describeSnapshotFrames(this.page), identities);
    const stable = enrichInteractionNodesWithCdpIdentity(raw, identities, { frameIdMap });
    const normalized = await enrichInteractionNodesWithCdpGeometry(stable, this.session);
    this.identities = identities;
    return normalized;
  }

  async targetPoint(node: InteractionNode): Promise<Point | null> {
    if (!this.identities) await this.snapshot();
    return findCdpHitTestedTargetPoint(this.session, this.identities!, node);
  }

  async pointStillTargets(node: InteractionNode, point: Point): Promise<boolean> {
    if (!this.identities) await this.snapshot();
    let result = await pointHitsCdpInteractionNode(this.session, this.identities!, node, point);
    if (result.hit) return true;
    // Hover/focus handlers can mutate descendants. Refresh identities once so a
    // newly inserted descendant can still be recognized as belonging to target.
    this.identities = await captureCdpIdentityIndex(this.session);
    result = await pointHitsCdpInteractionNode(this.session, this.identities, node, point);
    return result.hit;
  }
}
