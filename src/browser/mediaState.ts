import type { CdpSessionLike } from './cdpIdentity.js';

export type MediaPlaybackState = 'playing' | 'paused' | 'ended' | 'unknown';

export interface MediaElementIdentity {
  frameId: string;
  backendNodeId: number;
  /** Position among media elements in the owning frame at observation time. */
  ordinal: number;
  tagName: 'audio' | 'video' | 'unknown';
  id?: string;
  ariaLabel?: string;
}

export interface MediaElementState {
  identity: MediaElementIdentity;
  playbackState: MediaPlaybackState;
  muted?: boolean;
  volume?: number;
  currentTimeSeconds?: number;
  durationSeconds?: number;
  playbackRate?: number;
  visible?: boolean;
}

export interface FullscreenElementIdentity {
  frameId: string;
  backendNodeId: number;
  tagName: string;
  id?: string;
  ariaLabel?: string;
}

export type PageFullscreenState = 'active' | 'inactive' | 'unknown';
export type BrowserWindowFullscreenState = 'fullscreen' | 'not-fullscreen' | 'unknown';

export interface FullscreenState {
  pageState: PageFullscreenState;
  owner?: FullscreenElementIdentity;
  browserWindowState: BrowserWindowFullscreenState;
}

export interface MediaObservationError {
  scope: 'frames' | 'frame' | 'media' | 'fullscreen' | 'browser-window';
  operation: string;
  frameId?: string;
  message: string;
}

export interface MediaStateSnapshot {
  media: MediaElementState[];
  /** Preferred currently-playing element; undefined when nothing is playing. */
  activeMedia?: MediaElementIdentity;
  activeMediaCount: number;
  fullscreen: FullscreenState;
  truncated: boolean;
  errors: MediaObservationError[];
}

export interface ObserveMediaStateOptions {
  maxFrames?: number;
  maxMediaElements?: number;
  maxErrors?: number;
  maxTextLength?: number;
  maxTimeSeconds?: number;
}

interface RawFrame { id: string; parentId?: string; }
interface RawFrameTree { frame: RawFrame; childFrames?: RawFrameTree[]; }
interface FrameDescriptor { frameId: string; depth: number; }
interface RawMediaValue {
  tagName?: unknown;
  id?: unknown;
  ariaLabel?: unknown;
  playbackState?: unknown;
  muted?: unknown;
  volume?: unknown;
  currentTimeSeconds?: unknown;
  durationSeconds?: unknown;
  playbackRate?: unknown;
  visible?: unknown;
}
interface RawFullscreenValue { tagName?: unknown; id?: unknown; ariaLabel?: unknown; }

const DEFAULT_MAX_FRAMES = 16;
const DEFAULT_MAX_MEDIA_ELEMENTS = 32;
const DEFAULT_MAX_ERRORS = 16;
const DEFAULT_MAX_TEXT_LENGTH = 256;
const DEFAULT_MAX_TIME_SECONDS = 7 * 24 * 60 * 60;

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}
function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.length <= maxLength ? normalized : normalized.slice(0, maxLength);
}
function boundedNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) return undefined;
  return value;
}
function errorMessage(error: unknown, maxTextLength: number): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= maxTextLength ? text : text.slice(0, maxTextLength);
}
function flattenFrames(frameTree: RawFrameTree, maxFrames: number): { frames: FrameDescriptor[]; truncated: boolean } {
  const frames: FrameDescriptor[] = [];
  let truncated = false;
  const visit = (tree: RawFrameTree, depth: number) => {
    if (frames.length >= maxFrames) { truncated = true; return; }
    frames.push({ frameId: tree.frame.id, depth });
    for (const child of tree.childFrames ?? []) visit(child, depth + 1);
  };
  visit(frameTree, 0);
  return { frames, truncated };
}
function throwForException(result: any, operation: string): void {
  if (!result?.exceptionDetails) return;
  const description = result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text ?? 'runtime exception';
  throw new Error(`${operation}: ${String(description)}`);
}
async function createWorld(session: CdpSessionLike, frameId: string): Promise<number> {
  const result = await session.send('Page.createIsolatedWorld', { frameId, worldName: 'browser-automation-media-observer' });
  if (!Number.isInteger(result?.executionContextId)) throw new Error('Page.createIsolatedWorld returned no executionContextId');
  return result.executionContextId;
}
async function evaluateObject(session: CdpSessionLike, contextId: number, expression: string): Promise<any> {
  const result = await session.send('Runtime.evaluate', { expression, contextId, returnByValue: false, silent: true });
  throwForException(result, 'Runtime.evaluate');
  return result?.result;
}
async function callByValue(session: CdpSessionLike, objectId: string, functionDeclaration: string): Promise<any> {
  const result = await session.send('Runtime.callFunctionOn', { objectId, functionDeclaration, returnByValue: true, awaitPromise: true, silent: true });
  throwForException(result, 'Runtime.callFunctionOn');
  return result?.result?.value;
}
async function releaseObject(session: CdpSessionLike, objectId: string | undefined): Promise<void> {
  if (!objectId) return;
  try { await session.send('Runtime.releaseObject', { objectId }); } catch {}
}
async function describeBackendNodeId(session: CdpSessionLike, objectId: string): Promise<number> {
  const result = await session.send('DOM.describeNode', { objectId, depth: 0, pierce: true });
  const backendNodeId = result?.node?.backendNodeId;
  if (!Number.isInteger(backendNodeId)) throw new Error('DOM.describeNode returned no backendNodeId');
  return backendNodeId;
}

function parseMediaState(frameId: string, ordinal: number, backendNodeId: number, raw: RawMediaValue, maxTextLength: number, maxTimeSeconds: number): MediaElementState {
  const rawTagName = typeof raw.tagName === 'string' ? raw.tagName.toLowerCase() : '';
  const tagName: MediaElementIdentity['tagName'] = rawTagName === 'audio' || rawTagName === 'video' ? rawTagName : 'unknown';
  const rawPlayback = raw.playbackState;
  const playbackState: MediaPlaybackState = rawPlayback === 'playing' || rawPlayback === 'paused' || rawPlayback === 'ended' ? rawPlayback : 'unknown';
  return {
    identity: {
      frameId,
      backendNodeId,
      ordinal,
      tagName,
      id: boundedText(raw.id, maxTextLength),
      ariaLabel: boundedText(raw.ariaLabel, maxTextLength),
    },
    playbackState,
    muted: typeof raw.muted === 'boolean' ? raw.muted : undefined,
    volume: boundedNumber(raw.volume, 0, 1),
    currentTimeSeconds: boundedNumber(raw.currentTimeSeconds, 0, maxTimeSeconds),
    durationSeconds: boundedNumber(raw.durationSeconds, 0, maxTimeSeconds),
    playbackRate: boundedNumber(raw.playbackRate, 0.0625, 16),
    visible: typeof raw.visible === 'boolean' ? raw.visible : undefined,
  };
}

const MEDIA_ELEMENTS_EXPRESSION = `(() => {
  const found = [];
  const visit = (root) => {
    for (const media of root.querySelectorAll('audio,video')) found.push(media);
    for (const element of root.querySelectorAll('*')) {
      if (element.shadowRoot) visit(element.shadowRoot);
    }
  };
  visit(document);
  return found;
})()`;

const MEDIA_STATE_FUNCTION = `function() {
  const text = (value, max) => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, max) : undefined;
  };
  const finite = (value) => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const rect = this.getBoundingClientRect();
  const style = getComputedStyle(this);
  return {
    tagName: this.tagName.toLowerCase(),
    id: text(this.id, 512),
    ariaLabel: text(this.getAttribute('aria-label'), 512),
    playbackState: this.ended ? 'ended' : (this.paused ? 'paused' : 'playing'),
    muted: Boolean(this.muted),
    volume: finite(this.volume),
    currentTimeSeconds: finite(this.currentTime),
    durationSeconds: finite(this.duration),
    playbackRate: finite(this.playbackRate),
    visible: rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none',
  };
}`;

const FULLSCREEN_ELEMENT_EXPRESSION = `(() => {
  let owner = document.fullscreenElement;
  while (owner && owner.shadowRoot && owner.shadowRoot.fullscreenElement) {
    owner = owner.shadowRoot.fullscreenElement;
  }
  return owner;
})()`;

const FULLSCREEN_IDENTITY_FUNCTION = `function() {
  const text = (value) => {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed ? trimmed.slice(0, 512) : undefined;
  };
  return {
    tagName: String(this.tagName || '').toLowerCase(),
    id: text(this.id),
    ariaLabel: text(this.getAttribute && this.getAttribute('aria-label')),
  };
}`;

function mediaActivityScore(state: MediaElementState): number {
  if (state.playbackState !== 'playing') return -1;
  let score = 0;
  if (state.visible) score += 2;
  if (state.muted === false && (state.volume ?? 0) > 0) score += 4;
  if (state.identity.tagName === 'video') score += 1;
  return score;
}

/** Observe bounded HTML media and fullscreen state across the current frame tree. */
export async function observeMediaState(session: CdpSessionLike, options: ObserveMediaStateOptions = {}): Promise<MediaStateSnapshot> {
  const maxFrames = boundedInteger(options.maxFrames, DEFAULT_MAX_FRAMES, 1, 128);
  const maxMediaElements = boundedInteger(options.maxMediaElements, DEFAULT_MAX_MEDIA_ELEMENTS, 1, 256);
  const maxErrors = boundedInteger(options.maxErrors, DEFAULT_MAX_ERRORS, 1, 128);
  const maxTextLength = boundedInteger(options.maxTextLength, DEFAULT_MAX_TEXT_LENGTH, 32, 2048);
  const maxTimeSeconds = boundedInteger(options.maxTimeSeconds, DEFAULT_MAX_TIME_SECONDS, 60, 31 * 24 * 60 * 60);

  const errors: MediaObservationError[] = [];
  let errorsTruncated = false;
  const recordError = (error: MediaObservationError) => {
    if (errors.length < maxErrors) errors.push(error);
    else errorsTruncated = true;
  };

  let frames: FrameDescriptor[] = [];
  let truncated = false;
  try {
    const frameResult = await session.send('Page.getFrameTree');
    if (!frameResult?.frameTree?.frame?.id) throw new Error('Page.getFrameTree returned no root frame');
    const flattened = flattenFrames(frameResult.frameTree as RawFrameTree, maxFrames);
    frames = flattened.frames;
    truncated = flattened.truncated;
  } catch (error) {
    recordError({ scope: 'frames', operation: 'Page.getFrameTree', message: errorMessage(error, maxTextLength) });
  }

  const media: MediaElementState[] = [];
  const fullscreenCandidates: Array<{ depth: number; identity: FullscreenElementIdentity }> = [];
  let fullscreenChecks = 0;

  for (const frame of frames) {
    let contextId: number;
    try {
      contextId = await createWorld(session, frame.frameId);
    } catch (error) {
      recordError({ scope: 'frame', operation: 'Page.createIsolatedWorld', frameId: frame.frameId, message: errorMessage(error, maxTextLength) });
      continue;
    }

    if (media.length < maxMediaElements) {
      let mediaArrayId: string | undefined;
      try {
        const mediaArray = await evaluateObject(session, contextId, MEDIA_ELEMENTS_EXPRESSION);
        mediaArrayId = typeof mediaArray?.objectId === 'string' ? mediaArray.objectId : undefined;
        if (mediaArrayId) {
          const properties = await session.send('Runtime.getProperties', { objectId: mediaArrayId, ownProperties: true });
          const indexed = (properties?.result ?? [])
            .filter((property: any) => /^\d+$/.test(String(property?.name)) && typeof property?.value?.objectId === 'string')
            .sort((a: any, b: any) => Number(a.name) - Number(b.name));
          if (indexed.length > maxMediaElements - media.length) truncated = true;
          for (const property of indexed.slice(0, maxMediaElements - media.length)) {
            const objectId = property.value.objectId as string;
            try {
              const [backendNodeId, raw] = await Promise.all([
                describeBackendNodeId(session, objectId),
                callByValue(session, objectId, MEDIA_STATE_FUNCTION),
              ]);
              media.push(parseMediaState(frame.frameId, Number(property.name), backendNodeId, (raw ?? {}) as RawMediaValue, maxTextLength, maxTimeSeconds));
            } catch (error) {
              recordError({ scope: 'media', operation: 'observe-element', frameId: frame.frameId, message: errorMessage(error, maxTextLength) });
            } finally {
              await releaseObject(session, objectId);
            }
          }
        }
      } catch (error) {
        recordError({ scope: 'media', operation: 'enumerate-elements', frameId: frame.frameId, message: errorMessage(error, maxTextLength) });
      } finally {
        await releaseObject(session, mediaArrayId);
      }
    } else {
      truncated = true;
    }

    let fullscreenObjectId: string | undefined;
    try {
      const fullscreenObject = await evaluateObject(session, contextId, FULLSCREEN_ELEMENT_EXPRESSION);
      fullscreenChecks += 1;
      fullscreenObjectId = typeof fullscreenObject?.objectId === 'string' ? fullscreenObject.objectId : undefined;
      if (fullscreenObjectId) {
        const [backendNodeId, raw] = await Promise.all([
          describeBackendNodeId(session, fullscreenObjectId),
          callByValue(session, fullscreenObjectId, FULLSCREEN_IDENTITY_FUNCTION),
        ]);
        const value = (raw ?? {}) as RawFullscreenValue;
        fullscreenCandidates.push({ depth: frame.depth, identity: {
          frameId: frame.frameId,
          backendNodeId,
          tagName: boundedText(value.tagName, maxTextLength) ?? 'unknown',
          id: boundedText(value.id, maxTextLength),
          ariaLabel: boundedText(value.ariaLabel, maxTextLength),
        } });
      }
    } catch (error) {
      recordError({ scope: 'fullscreen', operation: 'document.fullscreenElement', frameId: frame.frameId, message: errorMessage(error, maxTextLength) });
    } finally {
      await releaseObject(session, fullscreenObjectId);
    }
  }

  let browserWindowState: BrowserWindowFullscreenState = 'unknown';
  try {
    const windowResult = await session.send('Browser.getWindowForTarget');
    const windowState = windowResult?.bounds?.windowState;
    if (windowState === 'fullscreen') browserWindowState = 'fullscreen';
    else if (typeof windowState === 'string') browserWindowState = 'not-fullscreen';
  } catch (error) {
    recordError({ scope: 'browser-window', operation: 'Browser.getWindowForTarget', message: errorMessage(error, maxTextLength) });
  }

  const owner = fullscreenCandidates.sort((a, b) => b.depth - a.depth)[0]?.identity;
  const pageState: PageFullscreenState = owner ? 'active' : (frames.length > 0 && fullscreenChecks === frames.length ? 'inactive' : 'unknown');
  const playing = media.filter((state) => state.playbackState === 'playing');
  const activeMedia = playing
    .map((state, index) => ({ state, index, score: mediaActivityScore(state) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)[0]?.state.identity;

  return {
    media,
    activeMedia,
    activeMediaCount: playing.length,
    fullscreen: { pageState, owner, browserWindowState },
    truncated: truncated || errorsTruncated,
    errors,
  };
}
