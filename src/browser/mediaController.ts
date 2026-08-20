import type { CdpSessionLike } from './cdpIdentity.js';
import type { MediaElementIdentity } from './mediaState.js';

export type MediaControlStatus =
  | 'verified'
  | 'invalid-argument'
  | 'target-missing'
  | 'rejected'
  | 'verification-failed'
  | 'protocol-error';

export interface MediaControlResult {
  status: MediaControlStatus;
  action: 'play' | 'pause' | 'set-muted' | 'set-volume' | 'seek' | 'set-playback-rate' | 'request-fullscreen' | 'exit-fullscreen';
  frameId: string;
  backendNodeId?: number;
  errorText?: string;
}

interface ControlState {
  paused?: unknown;
  ended?: unknown;
  muted?: unknown;
  volume?: unknown;
  currentTime?: unknown;
  playbackRate?: unknown;
  fullscreen?: unknown;
  rejected?: unknown;
}

const MAX_SEEK_SECONDS = 7 * 24 * 60 * 60;

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 256 ? text : text.slice(0, 256);
}

async function createWorld(session: CdpSessionLike, frameId: string): Promise<number> {
  const result = await session.send('Page.createIsolatedWorld', {
    frameId,
    worldName: 'browser-automation-media-controller',
  });
  if (!Number.isInteger(result?.executionContextId)) throw new Error('Page.createIsolatedWorld returned no executionContextId');
  return result.executionContextId;
}

async function resolveNode(session: CdpSessionLike, contextId: number, backendNodeId: number): Promise<string | undefined> {
  const result = await session.send('DOM.resolveNode', { backendNodeId, executionContextId: contextId });
  return typeof result?.object?.objectId === 'string' ? result.object.objectId : undefined;
}

function throwForException(result: any, operation: string): void {
  if (!result?.exceptionDetails) return;
  const description = result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text ?? 'runtime exception';
  throw new Error(`${operation}: ${String(description)}`);
}

async function callOnNode(
  session: CdpSessionLike,
  objectId: string,
  functionDeclaration: string,
  args: unknown[] = [],
  userGesture = false,
): Promise<any> {
  const result = await session.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    awaitPromise: true,
    returnByValue: true,
    userGesture,
    silent: true,
  });
  throwForException(result, 'Runtime.callFunctionOn');
  return result?.result?.value;
}

async function releaseObject(session: CdpSessionLike, objectId: string | undefined): Promise<void> {
  if (!objectId) return;
  try { await session.send('Runtime.releaseObject', { objectId }); } catch {}
}

const MEDIA_CONTROL_FUNCTION = `async function(action, value) {
  if (!(this instanceof HTMLMediaElement)) throw new TypeError('Target is not an HTMLMediaElement');
  let rejected;
  const rememberRejection = (promise) => {
    if (promise && typeof promise.catch === 'function') {
      promise.catch((error) => { rejected = String(error && (error.name || error.message || error)).slice(0, 256); });
    }
  };
  if (action === 'play') rememberRejection(this.play());
  else if (action === 'pause') this.pause();
  else if (action === 'set-muted') this.muted = Boolean(value);
  else if (action === 'set-volume') this.volume = value;
  else if (action === 'seek') this.currentTime = value;
  else if (action === 'set-playback-rate') this.playbackRate = value;
  else if (action === 'request-fullscreen') rememberRejection(this.requestFullscreen());
  else throw new TypeError('Unknown media action');
  if (action === 'play' || action === 'request-fullscreen') {
    for (let i = 0; i < 40; i += 1) {
      if (rejected) break;
      if (action === 'play' && !this.paused && !this.ended) break;
      if (action === 'request-fullscreen' && document.fullscreenElement === this) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return {
    paused: this.paused,
    ended: this.ended,
    muted: this.muted,
    volume: this.volume,
    currentTime: this.currentTime,
    playbackRate: this.playbackRate,
    fullscreen: document.fullscreenElement === this,
    rejected,
  };
}`;

function approximate(value: unknown, expected: number, epsilon = 0.05): boolean {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value - expected) <= epsilon;
}

function verify(action: MediaControlResult['action'], state: ControlState, expected?: unknown): boolean {
  switch (action) {
    case 'play': return state.paused === false && state.ended === false;
    case 'pause': return state.paused === true;
    case 'set-muted': return state.muted === expected;
    case 'set-volume': return typeof expected === 'number' && approximate(state.volume, expected, 0.001);
    case 'seek': return typeof expected === 'number' && approximate(state.currentTime, expected);
    case 'set-playback-rate': return typeof expected === 'number' && approximate(state.playbackRate, expected, 0.001);
    case 'request-fullscreen': return state.fullscreen === true;
    default: return false;
  }
}

async function controlMedia(
  session: CdpSessionLike,
  target: MediaElementIdentity,
  action: Exclude<MediaControlResult['action'], 'exit-fullscreen'>,
  expected?: unknown,
): Promise<MediaControlResult> {
  let objectId: string | undefined;
  try {
    const contextId = await createWorld(session, target.frameId);
    objectId = await resolveNode(session, contextId, target.backendNodeId);
    if (!objectId) {
      return { status: 'target-missing', action, frameId: target.frameId, backendNodeId: target.backendNodeId };
    }
    const state = await callOnNode(
      session,
      objectId,
      MEDIA_CONTROL_FUNCTION,
      [action, expected],
      action === 'play' || action === 'request-fullscreen',
    ) as ControlState;
    const verified = verify(action, state ?? {}, expected);
    return {
      status: verified ? 'verified' : (typeof state?.rejected === 'string' ? 'rejected' : 'verification-failed'),
      action,
      frameId: target.frameId,
      backendNodeId: target.backendNodeId,
      errorText: typeof state?.rejected === 'string' ? state.rejected : undefined,
    };
  } catch (error) {
    const message = errorText(error);
    const rejected = /NotAllowedError|NotSupportedError|AbortError|InvalidStateError/i.test(message);
    return {
      status: rejected ? 'rejected' : 'protocol-error',
      action,
      frameId: target.frameId,
      backendNodeId: target.backendNodeId,
      errorText: message,
    };
  } finally {
    await releaseObject(session, objectId);
  }
}

/** Browser-native HTMLMediaElement/fullscreen controls invoked through CDP, never synthetic DOM events. */
export class CdpMediaController {
  constructor(private readonly session: CdpSessionLike) {}

  play(target: MediaElementIdentity): Promise<MediaControlResult> {
    return controlMedia(this.session, target, 'play');
  }

  pause(target: MediaElementIdentity): Promise<MediaControlResult> {
    return controlMedia(this.session, target, 'pause');
  }

  setMuted(target: MediaElementIdentity, muted: boolean): Promise<MediaControlResult> {
    return controlMedia(this.session, target, 'set-muted', muted);
  }

  setVolume(target: MediaElementIdentity, volume: number): Promise<MediaControlResult> {
    if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
      return Promise.resolve({
        status: 'invalid-argument', action: 'set-volume', frameId: target.frameId, backendNodeId: target.backendNodeId,
      });
    }
    return controlMedia(this.session, target, 'set-volume', volume);
  }

  seek(target: MediaElementIdentity, currentTimeSeconds: number): Promise<MediaControlResult> {
    if (!Number.isFinite(currentTimeSeconds) || currentTimeSeconds < 0 || currentTimeSeconds > MAX_SEEK_SECONDS) {
      return Promise.resolve({
        status: 'invalid-argument', action: 'seek', frameId: target.frameId, backendNodeId: target.backendNodeId,
      });
    }
    return controlMedia(this.session, target, 'seek', currentTimeSeconds);
  }

  setPlaybackRate(target: MediaElementIdentity, playbackRate: number): Promise<MediaControlResult> {
    if (!Number.isFinite(playbackRate) || playbackRate < 0.0625 || playbackRate > 16) {
      return Promise.resolve({
        status: 'invalid-argument', action: 'set-playback-rate', frameId: target.frameId, backendNodeId: target.backendNodeId,
      });
    }
    return controlMedia(this.session, target, 'set-playback-rate', playbackRate);
  }

  requestFullscreen(target: MediaElementIdentity): Promise<MediaControlResult> {
    return controlMedia(this.session, target, 'request-fullscreen');
  }

  async exitFullscreen(frameId: string): Promise<MediaControlResult> {
    try {
      const contextId = await createWorld(this.session, frameId);
      const result = await this.session.send('Runtime.evaluate', {
        expression: `(async () => {
          if (!document.fullscreenElement) return { hadFullscreen: false, fullscreen: false };
          let rejected;
          const pending = document.exitFullscreen();
          if (pending && typeof pending.catch === 'function') {
            pending.catch((error) => { rejected = String(error && (error.name || error.message || error)).slice(0, 256); });
          }
          for (let i = 0; i < 40; i += 1) {
            if (rejected || !document.fullscreenElement) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return { hadFullscreen: true, fullscreen: Boolean(document.fullscreenElement), rejected };
        })()`,
        contextId,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
        silent: true,
      });
      throwForException(result, 'Runtime.evaluate');
      const value = result?.result?.value;
      if (value?.hadFullscreen !== true) return { status: 'rejected', action: 'exit-fullscreen', frameId };
      if (typeof value?.rejected === 'string') return { status: 'rejected', action: 'exit-fullscreen', frameId, errorText: value.rejected };
      return { status: value?.fullscreen === false ? 'verified' : 'verification-failed', action: 'exit-fullscreen', frameId };
    } catch (error) {
      const message = errorText(error);
      const rejected = /NotAllowedError|NotSupportedError|AbortError|InvalidStateError/i.test(message);
      return { status: rejected ? 'rejected' : 'protocol-error', action: 'exit-fullscreen', frameId, errorText: message };
    }
  }
}
