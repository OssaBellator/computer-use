import { intersectRect } from '../geometry.js';
import type { Rect } from '../types.js';
import { captureCdpViewportGeometry, quadToRect } from './cdpGeometry.js';
import type { CdpSessionLike } from './cdpIdentity.js';

export type GameRegionKind = 'canvas' | 'video' | 'application' | 'iframe';

export interface GameRegionCandidate {
  kind: GameRegionKind;
  backendNodeId: number;
  /** Browser-authoritative main-viewport border box. */
  rect: Rect;
  /** Visible main-viewport crop suitable for bounded screenshot capture. */
  clip: Rect;
  visibleFraction: number;
  viewportCoverage: number;
  /** Deterministic ranking score; meaningful only relative to candidates from the same locate() call. */
  score: number;
}

export interface GameRegionLocatorOptions {
  /** Ignore narrower candidates. Defaults to 96 CSS pixels. */
  minWidth?: number;
  /** Ignore shorter candidates. Defaults to 64 CSS pixels. */
  minHeight?: number;
  /** Minimum visible fraction of the element border box. Defaults to 0.25. */
  minVisibleFraction?: number;
  /** Hard bound on DOM search results inspected. Defaults to 128. */
  maxSearchResults?: number;
  /** Hard bound on ranked candidates returned. Defaults to 8. */
  maxCandidates?: number;
}

export interface GameRegionResult {
  viewportRect: Rect;
  primary?: GameRegionCandidate;
  candidates: GameRegionCandidate[];
}

interface SearchResult {
  searchId?: string;
  resultCount?: number;
}

interface SearchNodes {
  nodeIds?: number[];
}

interface DescribedNode {
  node?: {
    backendNodeId?: number;
    localName?: string;
    nodeName?: string;
    attributes?: string[];
  };
}

interface BoxModelResult {
  model?: { border?: number[] };
}

const KIND_WEIGHT: Record<GameRegionKind, number> = {
  canvas: 1.25,
  video: 1.1,
  application: 1,
  iframe: 0.75,
};

function finiteNonNegative(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be finite and non-negative`);
  }
  return value;
}

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function attributesMap(attributes: string[] | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (let index = 0; index < (attributes?.length ?? 0); index += 2) {
    map.set(attributes![index].toLowerCase(), attributes![index + 1] ?? '');
  }
  return map;
}

function kindFor(node: NonNullable<DescribedNode['node']>): GameRegionKind | undefined {
  const localName = (node.localName || node.nodeName || '').toLowerCase();
  if (localName === 'canvas' || localName === 'video' || localName === 'iframe') return localName;
  const role = attributesMap(node.attributes).get('role')?.toLowerCase();
  return role === 'application' ? 'application' : undefined;
}

function area(rect: Rect): number {
  return rect.width * rect.height;
}

/**
 * Locate likely browser-game visual surfaces without requiring a caller-supplied
 * screenshot crop. Search is bounded and restricted to common game/render hosts:
 * canvas, video, iframe, and explicit role=application regions.
 *
 * The primary result is a heuristic acquisition candidate, not a claim that the
 * page is a game. Callers should keep re-observing/validating state after using it.
 */
export class CdpGameRegionLocator {
  constructor(private readonly session: CdpSessionLike) {}

  async locate(options: GameRegionLocatorOptions = {}): Promise<GameRegionResult> {
    const minWidth = finiteNonNegative('minWidth', options.minWidth ?? 96);
    const minHeight = finiteNonNegative('minHeight', options.minHeight ?? 64);
    const minVisibleFraction = options.minVisibleFraction ?? 0.25;
    if (!Number.isFinite(minVisibleFraction) || minVisibleFraction < 0 || minVisibleFraction > 1) {
      throw new Error('minVisibleFraction must be in [0,1]');
    }
    const maxSearchResults = positiveInteger('maxSearchResults', options.maxSearchResults ?? 128);
    const maxCandidates = positiveInteger('maxCandidates', options.maxCandidates ?? 8);

    const { viewportRect } = await captureCdpViewportGeometry(this.session);
    const viewportArea = Math.max(1, area(viewportRect));

    await this.session.send('DOM.enable');
    // Materialize the document tree before performSearch. Chromium otherwise may
    // report an empty search on a newly attached target even when matching nodes exist.
    await this.session.send('DOM.getDocument', { depth: 0, pierce: true });
    const search = await this.session.send('DOM.performSearch', {
      query: 'canvas, video, iframe, [role="application"]',
      includeUserAgentShadowDOM: true,
    }) as SearchResult;

    if (!search.searchId || !Number.isInteger(search.resultCount) || (search.resultCount ?? 0) <= 0) {
      if (search.searchId) {
        await this.session.send('DOM.discardSearchResults', { searchId: search.searchId });
      }
      return { viewportRect, candidates: [] };
    }

    const toIndex = Math.min(search.resultCount!, maxSearchResults);
    try {
      const found = await this.session.send('DOM.getSearchResults', {
        searchId: search.searchId,
        fromIndex: 0,
        toIndex,
      }) as SearchNodes;
      const candidates: GameRegionCandidate[] = [];

      for (const nodeId of found.nodeIds ?? []) {
        try {
          const described = await this.session.send('DOM.describeNode', { nodeId }) as DescribedNode;
          const node = described.node;
          if (!node || typeof node.backendNodeId !== 'number') continue;
          const kind = kindFor(node);
          if (!kind) continue;

          const box = await this.session.send('DOM.getBoxModel', { nodeId }) as BoxModelResult;
          const rect = quadToRect(box.model?.border ?? []);
          if (!rect || rect.width < minWidth || rect.height < minHeight) continue;

          const clip = intersectRect(rect, viewportRect);
          if (!clip) continue;
          const visibleFraction = area(clip) / area(rect);
          if (visibleFraction < minVisibleFraction) continue;

          const viewportCoverage = area(clip) / viewportArea;
          const score = area(clip) * KIND_WEIGHT[kind] * (0.5 + 0.5 * visibleFraction);
          candidates.push({
            kind,
            backendNodeId: node.backendNodeId,
            rect,
            clip,
            visibleFraction,
            viewportCoverage,
            score,
          });
        } catch {
          // Detached/unsupported individual candidates do not invalidate the search.
        }
      }

      candidates.sort((a, b) =>
        b.score - a.score ||
        b.viewportCoverage - a.viewportCoverage ||
        a.backendNodeId - b.backendNodeId,
      );
      const bounded = candidates.slice(0, maxCandidates);
      return {
        viewportRect,
        ...(bounded[0] ? { primary: bounded[0] } : {}),
        candidates: bounded,
      };
    } finally {
      await this.session.send('DOM.discardSearchResults', { searchId: search.searchId });
    }
  }
}
