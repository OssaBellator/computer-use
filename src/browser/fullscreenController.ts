import type { CdpSessionLike } from './cdpIdentity.js';

export type FullscreenControlStatus =
  | 'verified'
  | 'target-missing'
  | 'rejected'
  | 'verification-failed'
  | 'protocol-error';

export interface FullscreenTargetIdentity {
  frameId: string;
  backendNodeId: number;
}

export interface FullscreenControlResult {
  status: FullscreenControlStatus;
  action: 'request-fullscreen' | 'exit-fullscreen';
  frameId: string;
  backendNodeId?: number;
  errorText?: string;
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 256 ? text : text.slice(0, 256);
}

function isBrowserRejection(message: string): boolean {
  return /NotAllowedError|NotSupportedError|AbortError|InvalidStateError/i.test(message);
}

function throwForException(result: any, operation: string): void {
  if (!result?.exceptionDetails) return;
  const description = result.exceptionDetails?.exception?.description ?? result.exceptionDetails?.text ?? 'runtime exception';
  throw new Error(`${operation}: ${String(description)}`);
}

async function createWorld(session: CdpSessionLike, frameId: string): Promise<number> {
  const result = await session.send('Page.createIsolatedWorld', {
    frameId,
    worldName: 'browser-automation-fullscreen-controller',
  });
  if (!Number.isInteger(result?.executionContextId)) throw new Error('Page.createIsolatedWorld returned no executionContextId');
  return result.executionContextId;
}

async function resolveNode(session: CdpSessionLike, contextId: number, backendNodeId: number): Promise<string | undefined> {
  const result = await session.send('DOM.resolveNode', { backendNodeId, executionContextId: contextId });
  return typeof result?.object?.objectId === 'string' ? result.object.objectId : undefined;
}

async function releaseObject(session: CdpSessionLike, objectId: string | undefined): Promise<void> {
  if (!objectId) return;
  try { await session.send('Runtime.releaseObject', { objectId }); } catch {}
}

const REQUEST_FULLSCREEN_FUNCTION = `async function() {
  if (!(this instanceof Element)) throw new TypeError('Target is not an Element');
  if (typeof this.requestFullscreen !== 'function') return { rejected: 'NotSupportedError' };
  let rejected;
  const rootOwner = () => {
    const root = this.getRootNode && this.getRootNode();
    return root && 'fullscreenElement' in root ? root.fullscreenElement : document.fullscreenElement;
  };
  try {
    const pending = this.requestFullscreen();
    if (pending && typeof pending.catch === 'function') {
      pending.catch((error) => { rejected = String(error && (error.name || error.message || error)).slice(0, 256); });
    }
  } catch (error) {
    rejected = String(error && (error.name || error.message || error)).slice(0, 256);
  }
  for (let i = 0; i < 40; i += 1) {
    if (rejected || rootOwner() === this) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return { fullscreen: rootOwner() === this, rejected };
}`;

export class CdpFullscreenController {
  constructor(private readonly session: CdpSessionLike) {}

  async requestFullscreen(target: FullscreenTargetIdentity): Promise<FullscreenControlResult> {
    let objectId: string | undefined;
    try {
      const contextId = await createWorld(this.session, target.frameId);
      objectId = await resolveNode(this.session, contextId, target.backendNodeId);
      if (!objectId) {
        return {
          status: 'target-missing',
          action: 'request-fullscreen',
          frameId: target.frameId,
          backendNodeId: target.backendNodeId,
        };
      }
      const result = await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: REQUEST_FULLSCREEN_FUNCTION,
        awaitPromise: true,
        returnByValue: true,
        silent: true,
      });
      throwForException(result, 'Runtime.callFunctionOn');
      const value = result?.result?.value;
      return {
        status: value?.fullscreen === true ? 'verified' : (typeof value?.rejected === 'string' ? 'rejected' : 'verification-failed'),
        action: 'request-fullscreen',
        frameId: target.frameId,
        backendNodeId: target.backendNodeId,
        errorText: typeof value?.rejected === 'string' ? value.rejected : undefined,
      };
    } catch (error) {
      const message = errorText(error);
      return {
        status: isBrowserRejection(message) ? 'rejected' : 'protocol-error',
        action: 'request-fullscreen',
        frameId: target.frameId,
        backendNodeId: target.backendNodeId,
        errorText: message,
      };
    } finally {
      await releaseObject(this.session, objectId);
    }
  }

  async exitFullscreen(frameId: string): Promise<FullscreenControlResult> {
    try {
      const contextId = await createWorld(this.session, frameId);
      const result = await this.session.send('Runtime.evaluate', {
        expression: `(async () => {
          if (!document.fullscreenElement) return { fullscreen: false };
          let rejected;
          try {
            const pending = document.exitFullscreen();
            if (pending && typeof pending.catch === 'function') {
              pending.catch((error) => { rejected = String(error && (error.name || error.message || error)).slice(0, 256); });
            }
          } catch (error) {
            rejected = String(error && (error.name || error.message || error)).slice(0, 256);
          }
          for (let i = 0; i < 40; i += 1) {
            if (rejected || !document.fullscreenElement) break;
            await new Promise((resolve) => setTimeout(resolve, 25));
          }
          return { fullscreen: Boolean(document.fullscreenElement), rejected };
        })()`,
        contextId,
        awaitPromise: true,
        returnByValue: true,
        silent: true,
      });
      throwForException(result, 'Runtime.evaluate');
      const value = result?.result?.value;
      if (typeof value?.rejected === 'string') {
        return { status: 'rejected', action: 'exit-fullscreen', frameId, errorText: value.rejected };
      }
      return {
        status: value?.fullscreen === false ? 'verified' : 'verification-failed',
        action: 'exit-fullscreen',
        frameId,
      };
    } catch (error) {
      const message = errorText(error);
      return {
        status: isBrowserRejection(message) ? 'rejected' : 'protocol-error',
        action: 'exit-fullscreen',
        frameId,
        errorText: message,
      };
    }
  }
}
