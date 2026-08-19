import type { BrowserInteractionObserver } from './cdpObserver.js';
import type { InteractionNode, Point, Rect } from '../types.js';

export interface CoalescingObserverStats {
  snapshotRequests: number;
  sourceSnapshotCalls: number;
  coalescedSnapshotRequests: number;
}

/**
 * Collapses only concurrent snapshot requests. Once an observation resolves,
 * the next request always reaches the source observer, preserving closed-loop
 * freshness while avoiding duplicate full-tree work in the same in-flight window.
 */
export class CoalescingInteractionObserver implements BrowserInteractionObserver {
  private inflightSnapshot?: Promise<readonly InteractionNode[]>;
  private readonly counters: CoalescingObserverStats = {
    snapshotRequests: 0,
    sourceSnapshotCalls: 0,
    coalescedSnapshotRequests: 0,
  };

  constructor(readonly source: BrowserInteractionObserver) {}

  stats(): CoalescingObserverStats {
    return { ...this.counters };
  }

  async snapshot(): Promise<readonly InteractionNode[]> {
    this.counters.snapshotRequests += 1;
    if (this.inflightSnapshot) {
      this.counters.coalescedSnapshotRequests += 1;
      return this.inflightSnapshot;
    }

    this.counters.sourceSnapshotCalls += 1;
    const pending = this.source.snapshot();
    this.inflightSnapshot = pending;
    try {
      return await pending;
    } finally {
      if (this.inflightSnapshot === pending) this.inflightSnapshot = undefined;
    }
  }

  async targetPoint(node: InteractionNode): Promise<Point | null> {
    return this.source.targetPoint(node);
  }

  async pointStillTargets(node: InteractionNode, point: Point): Promise<boolean> {
    return this.source.pointStillTargets(node, point);
  }

  async viewportRect(): Promise<Rect> {
    if (!this.source.viewportRect) {
      throw new Error('source observer does not expose viewportRect');
    }
    return this.source.viewportRect();
  }
}
