import { intersectRect } from '../geometry.js';
import type { Rect } from '../types.js';
import { captureCdpViewportGeometry, quadToRect } from './cdpGeometry.js';
import type { CdpSessionLike } from './cdpIdentity.js';
import {
  CdpGameRegionLocator,
  type GameRegionCandidate,
  type GameRegionLocatorOptions,
  type GameRegionResult,
} from './gameRegionLocator.js';

export interface GameRegionLocatorLike {
  locate(options?: GameRegionLocatorOptions): Promise<GameRegionResult>;
}

export type GameRegionLeaseStatus =
  | 'acquired'
  | 'refreshed'
  | 'reacquired'
  | 'missing';

export interface GameRegionLeaseSnapshot {
  status: GameRegionLeaseStatus;
  /** Monotonic renderer acquisition generation. Starts at 1 for the first acquired backend node. */
  generation: number;
  region?: GameRegionCandidate;
  /** True when the backend identity, border box, or visible clip changed. */
  geometryChanged: boolean;
}

interface BoxModelResult {
  model?: { border?: number[] };
}

function area(rect: Pick<Rect, 'width' | 'height'>): number {
  return rect.width * rect.height;
}

function finiteNonNegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be finite and non-negative`);
  }
  return value;
}

function visibleFractionValue(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error('minVisibleFraction must be in [0,1]');
  }
  return value;
}

function sameRect(a: Rect, b: Rect): boolean {
  return Math.abs(a.x - b.x) < 0.01 &&
    Math.abs(a.y - b.y) < 0.01 &&
    Math.abs(a.width - b.width) < 0.01 &&
    Math.abs(a.height - b.height) < 0.01;
}

function sameOptionalRect(a: Rect | undefined, b: Rect | undefined): boolean {
  return (!a && !b) || (!!a && !!b && sameRect(a, b));
}

function regionChanged(
  previous: GameRegionCandidate | undefined,
  next: GameRegionCandidate | undefined,
): boolean {
  return previous?.backendNodeId !== next?.backendNodeId ||
    !sameOptionalRect(previous?.rect, next?.rect) ||
    !sameOptionalRect(previous?.clip, next?.clip);
}

function cloneRegion(region: GameRegionCandidate | undefined): GameRegionCandidate | undefined {
  if (!region) return undefined;
  return {
    ...region,
    rect: { ...region.rect },
    clip: { ...region.clip },
  };
}

/**
 * Maintain a short-lived lease on an acquired game surface.
 *
 * Refresh first probes the stable backend node directly, avoiding a full DOM
 * search while the renderer remains alive. Geometry is updated in place for
 * resize/fullscreen/layout changes. If the backend node is detached, hidden, or
 * no longer satisfies the acquisition bounds, the locator is run again and a
 * new generation is issued when renderer identity changes.
 */
export class CdpGameRegionLease {
  private region?: GameRegionCandidate;
  private generation = 0;

  constructor(
    private readonly session: CdpSessionLike,
    private readonly locator: GameRegionLocatorLike = new CdpGameRegionLocator(session),
  ) {}

  current(): GameRegionCandidate | undefined {
    return cloneRegion(this.region);
  }

  clear(): void {
    this.region = undefined;
    this.generation = 0;
  }

  async acquire(options: GameRegionLocatorOptions = {}): Promise<GameRegionLeaseSnapshot> {
    const previous = this.region;
    const located = await this.locator.locate(options);
    const next = located.primary;
    const geometryChanged = regionChanged(previous, next);

    if (next && previous?.backendNodeId !== next.backendNodeId) this.generation += 1;
    if (next && this.generation === 0) this.generation = 1;
    this.region = next;

    return {
      status: next ? 'acquired' : 'missing',
      generation: this.generation,
      ...(next ? { region: this.current() } : {}),
      geometryChanged,
    };
  }

  async refresh(options: GameRegionLocatorOptions = {}): Promise<GameRegionLeaseSnapshot> {
    const minWidth = finiteNonNegative('minWidth', options.minWidth ?? 96);
    const minHeight = finiteNonNegative('minHeight', options.minHeight ?? 64);
    const minVisibleFraction = visibleFractionValue(options.minVisibleFraction ?? 0.25);
    const previous = this.region;

    if (previous) {
      try {
        const { viewportRect } = await captureCdpViewportGeometry(this.session);
        const result = await this.session.send('DOM.getBoxModel', {
          backendNodeId: previous.backendNodeId,
        }) as BoxModelResult;
        const rect = quadToRect(result.model?.border ?? []);

        if (rect && rect.width >= minWidth && rect.height >= minHeight) {
          const clip = intersectRect(rect, viewportRect);
          if (clip) {
            const visibleFraction = area(clip) / area(rect);
            if (visibleFraction >= minVisibleFraction) {
              const next: GameRegionCandidate = {
                ...previous,
                rect,
                clip,
                visibleFraction,
                viewportCoverage: area(clip) / Math.max(1, area(viewportRect)),
              };
              const geometryChanged = regionChanged(previous, next);
              this.region = next;
              return {
                status: 'refreshed',
                generation: this.generation,
                region: this.current(),
                geometryChanged,
              };
            }
          }
        }
      } catch {
        // Detached/stale backend identity falls through to bounded reacquisition.
      }
    }

    const located = await this.locator.locate(options);
    const next = located.primary;
    const geometryChanged = regionChanged(previous, next);
    if (next && previous?.backendNodeId !== next.backendNodeId) this.generation += 1;
    if (next && this.generation === 0) this.generation = 1;
    this.region = next;

    return {
      status: next ? 'reacquired' : 'missing',
      generation: this.generation,
      ...(next ? { region: this.current() } : {}),
      geometryChanged,
    };
  }
}
