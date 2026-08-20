import type { CdpSessionLike } from './cdpIdentity.js';
import type { InteractionNode } from '../types.js';

export type BrowserSelectMatch = 'label' | 'value';
export type BrowserSelectStatus =
  | 'selected'
  | 'already-selected'
  | 'invalid-target'
  | 'not-select'
  | 'multiple-unsupported'
  | 'disabled'
  | 'option-not-found'
  | 'option-ambiguous'
  | 'option-disabled'
  | 'unverified'
  | 'protocol-error';

export interface BrowserSelectOptions {
  by?: BrowserSelectMatch;
}

export interface BrowserSelectResult {
  status: BrowserSelectStatus;
  target: InteractionNode | null;
  /** Selected option index only; option text/value is never returned. */
  selectedIndex?: number;
}

interface RuntimeCallResult {
  result?: { value?: unknown };
  exceptionDetails?: unknown;
}

interface MutationResult {
  status?: unknown;
  index?: unknown;
}

const MUTATION_STATUSES = new Set<BrowserSelectStatus>([
  'selected',
  'already-selected',
  'not-select',
  'multiple-unsupported',
  'disabled',
  'option-not-found',
  'option-ambiguous',
  'option-disabled',
  'unverified',
]);

function normalizeMutation(value: unknown): { status: BrowserSelectStatus; index?: number } {
  if (!value || typeof value !== 'object') return { status: 'protocol-error' };
  const raw = value as MutationResult;
  if (typeof raw.status !== 'string' || !MUTATION_STATUSES.has(raw.status as BrowserSelectStatus)) {
    return { status: 'protocol-error' };
  }
  const index = typeof raw.index === 'number' && Number.isInteger(raw.index) && raw.index >= 0
    ? raw.index
    : undefined;
  return {
    status: raw.status as BrowserSelectStatus,
    ...(index !== undefined ? { index } : {}),
  };
}

/**
 * Selects one option on a native single-select control without exporting the
 * page's option list. Matching occurs inside an isolated world against the
 * exact backend node and only coarse status/index metadata crosses back out.
 */
export class CdpSelectController {
  constructor(private readonly session: CdpSessionLike) {}

  async select(
    target: InteractionNode,
    desired: string,
    options: BrowserSelectOptions = {},
  ): Promise<BrowserSelectResult> {
    if (!Number.isInteger(target.backendNodeId) || (target.backendNodeId ?? 0) <= 0) {
      return { status: 'invalid-target', target };
    }
    if (!target.capabilities.includes('select')) {
      return { status: target.disabled ? 'disabled' : 'not-select', target };
    }
    if (target.disabled) return { status: 'disabled', target };

    const by = options.by ?? 'label';
    if (by !== 'label' && by !== 'value') return { status: 'protocol-error', target };

    let objectId: string | undefined;
    try {
      const world = await this.session.send('Page.createIsolatedWorld', {
        frameId: target.frameId,
        worldName: 'semantic-browser-select',
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
        functionDeclaration: `function(desired, by) {
          if (!(this instanceof HTMLSelectElement)) return { status: 'not-select' };
          if (!this.isConnected) return { status: 'unverified' };
          if (this.disabled) return { status: 'disabled' };
          if (this.multiple) return { status: 'multiple-unsupported' };
          const matches = [];
          for (let index = 0; index < this.options.length; index += 1) {
            const option = this.options[index];
            const candidate = by === 'value' ? option.value : option.label;
            if (candidate === desired) matches.push(index);
          }
          if (matches.length === 0) return { status: 'option-not-found' };
          if (matches.length !== 1) return { status: 'option-ambiguous' };
          const index = matches[0];
          const option = this.options[index];
          if (option.disabled) return { status: 'option-disabled' };
          if (this.selectedIndex === index) return { status: 'already-selected', index };
          this.selectedIndex = index;
          this.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
          this.dispatchEvent(new Event('change', { bubbles: true }));
          return {
            status: this.isConnected && this.selectedIndex === index ? 'selected' : 'unverified',
            index,
          };
        }`,
        arguments: [{ value: desired }, { value: by }],
        returnByValue: true,
        awaitPromise: false,
      }) as RuntimeCallResult;
      if (mutation.exceptionDetails) return { status: 'protocol-error', target };
      const normalized = normalizeMutation(mutation.result?.value);
      if (normalized.status !== 'selected' && normalized.status !== 'already-selected') {
        return { status: normalized.status, target };
      }
      if (normalized.index === undefined) return { status: 'protocol-error', target };

      const verification = await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: `function(index) {
          return this instanceof HTMLSelectElement &&
            this.isConnected && !this.multiple && this.selectedIndex === index;
        }`,
        arguments: [{ value: normalized.index }],
        returnByValue: true,
        awaitPromise: false,
      }) as RuntimeCallResult;
      if (verification.exceptionDetails || verification.result?.value !== true) {
        return { status: 'unverified', target };
      }
      return {
        status: normalized.status,
        target,
        selectedIndex: normalized.index,
      };
    } catch {
      return { status: 'protocol-error', target };
    } finally {
      if (objectId) {
        try { await this.session.send('Runtime.releaseObject', { objectId }); } catch {}
      }
    }
  }
}
