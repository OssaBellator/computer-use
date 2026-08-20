import type { CdpSessionLike } from './cdpIdentity.js';

export type BrowserDocumentReadyState = 'loading' | 'interactive' | 'complete';

export interface BrowserStateSnapshot {
  url: string;
  origin: string;
  title: string;
  readyState: BrowserDocumentReadyState;
  historyLength: number;
  /** Monotonic document identity signal: changes on cross-document navigation/reload. */
  timeOrigin: number;
}

interface RuntimeEvaluationResult {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

function isReadyState(value: unknown): value is BrowserDocumentReadyState {
  return value === 'loading' || value === 'interactive' || value === 'complete';
}

function normalizeBrowserState(value: unknown): BrowserStateSnapshot {
  if (!value || typeof value !== 'object') throw new Error('Runtime.evaluate did not return browser state');
  const raw = value as Record<string, unknown>;
  if (typeof raw.url !== 'string' || typeof raw.origin !== 'string' || typeof raw.title !== 'string') {
    throw new Error('Runtime.evaluate returned malformed browser state');
  }
  if (!isReadyState(raw.readyState)) throw new Error('Runtime.evaluate returned invalid document.readyState');
  if (typeof raw.historyLength !== 'number' || !Number.isFinite(raw.historyLength) || raw.historyLength < 0) {
    throw new Error('Runtime.evaluate returned invalid history.length');
  }
  if (typeof raw.timeOrigin !== 'number' || !Number.isFinite(raw.timeOrigin) || raw.timeOrigin < 0) {
    throw new Error('Runtime.evaluate returned invalid performance.timeOrigin');
  }
  return {
    url: raw.url,
    origin: raw.origin,
    title: raw.title,
    readyState: raw.readyState,
    historyLength: Math.floor(raw.historyLength),
    timeOrigin: raw.timeOrigin,
  };
}

/** Capture top-level browser state without injecting page-side event handlers. */
export async function captureCdpBrowserState(session: CdpSessionLike): Promise<BrowserStateSnapshot> {
  const evaluation = await session.send('Runtime.evaluate', {
    expression: `(() => ({
      url: location.href,
      origin: location.origin,
      title: document.title,
      readyState: document.readyState,
      historyLength: history.length,
      timeOrigin: performance.timeOrigin,
    }))()`,
    returnByValue: true,
    awaitPromise: false,
  }) as RuntimeEvaluationResult;

  if (evaluation.exceptionDetails) {
    const detail = evaluation.exceptionDetails.exception?.description ?? evaluation.exceptionDetails.text;
    throw new Error(detail ? `Failed to capture browser state: ${detail}` : 'Failed to capture browser state');
  }
  return normalizeBrowserState(evaluation.result?.value);
}
