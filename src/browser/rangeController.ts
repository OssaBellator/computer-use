import type { CdpSessionLike } from './cdpIdentity.js';
import type { InteractionNode } from '../types.js';

export type BrowserRangeStatus =
  | 'set'
  | 'already-set'
  | 'invalid-target'
  | 'not-range'
  | 'disabled'
  | 'invalid-value'
  | 'value-rejected'
  | 'unverified'
  | 'protocol-error';

export interface BrowserRangeResult {
  status: BrowserRangeStatus;
  target: InteractionNode | null;
}

interface RuntimeCallResult {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

interface MutationResult {
  status?: unknown;
}

const MUTATION_STATUSES = new Set<BrowserRangeStatus>([
  'set',
  'already-set',
  'not-range',
  'disabled',
  'invalid-value',
  'value-rejected',
  'unverified',
]);

function normalizeStatus(value: unknown): BrowserRangeStatus {
  if (!value || typeof value !== 'object') return 'protocol-error';
  const status = (value as MutationResult).status;
  return typeof status === 'string' && MUTATION_STATUSES.has(status as BrowserRangeStatus)
    ? status as BrowserRangeStatus
    : 'protocol-error';
}

/**
 * Sets one exact numeric value on a native input[type=range] without exporting
 * page min/max/step metadata. Mutation and verification run in an isolated world
 * against the exact backend node.
 */
export class CdpRangeController {
  constructor(private readonly session: CdpSessionLike) {}

  async set(target: InteractionNode, desired: string): Promise<BrowserRangeResult> {
    if (!Number.isInteger(target.backendNodeId) || (target.backendNodeId ?? 0) <= 0) {
      return { status: 'invalid-target', target };
    }
    if (!target.capabilities.includes('set-range')) {
      return { status: target.disabled ? 'disabled' : 'not-range', target };
    }
    if (target.disabled) return { status: 'disabled', target };

    let objectId: string | undefined;
    try {
      const world = await this.session.send('Page.createIsolatedWorld', {
        frameId: target.frameId,
        worldName: 'semantic-browser-range',
      }) as { executionContextId?: number };
      if (!Number.isInteger(world.executionContextId)) {
        return { status: 'protocol-error', target };
      }

      const resolved = await this.session.send('DOM.resolveNode', {
        backendNodeId: target.backendNodeId,
        executionContextId: world.executionContextId,
      }) as { object?: { objectId?: string } };
      objectId = resolved.object?.objectId;
      if (!objectId) return { status: 'invalid-target', target };

      const mutation = await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(desired) {
          if (!(this instanceof HTMLInputElement) || this.type !== 'range') {
            return { status: 'not-range' };
          }
          if (!this.isConnected) return { status: 'unverified' };
          if (this.disabled) return { status: 'disabled' };
          const numeric = Number(desired);
          if (!Number.isFinite(numeric)) return { status: 'invalid-value' };
          if (Object.is(this.valueAsNumber, numeric)) return { status: 'already-set' };
          this.valueAsNumber = numeric;
          if (!Object.is(this.valueAsNumber, numeric)) return { status: 'value-rejected' };
          this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return {
            status: this.isConnected && Object.is(this.valueAsNumber, numeric)
              ? 'set'
              : 'unverified',
          };
        }`,
        arguments: [{ value: desired }],
        returnByValue: true,
        awaitPromise: false,
      }) as RuntimeCallResult;
      if (mutation.exceptionDetails) return { status: 'protocol-error', target };
      const status = normalizeStatus(mutation.result?.value);
      if (status !== 'set' && status !== 'already-set') return { status, target };

      const verification = await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(desired) {
          const numeric = Number(desired);
          return this instanceof HTMLInputElement && this.type === 'range' &&
            this.isConnected && Number.isFinite(numeric) &&
            Object.is(this.valueAsNumber, numeric);
        }`,
        arguments: [{ value: desired }],
        returnByValue: true,
        awaitPromise: false,
      }) as RuntimeCallResult;
      if (verification.exceptionDetails || verification.result?.value !== true) {
        return { status: 'unverified', target };
      }
      return { status, target };
    } catch {
      return { status: 'protocol-error', target };
    } finally {
      if (objectId) {
        try { await this.session.send('Runtime.releaseObject', { objectId }); } catch {}
      }
    }
  }
}
