import type { CdpEventSessionLike } from './dialogController.js';

export interface NetworkActivitySummary {
  inFlight: number;
  started: number;
  finished: number;
  failed: number;
  activitySequence: number;
}

export interface NetworkIdleOptions {
  /** Continuous quiet period required after the last request-state change. */
  quietMs?: number;
  /** Maximum requests that may remain in flight while considering the page idle. */
  maxInflight?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface NetworkIdleResult {
  idle: boolean;
  summary: NetworkActivitySummary;
  elapsedMs: number;
  samples: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * URL-redacted CDP network lifecycle monitor. Request IDs are retained only
 * while needed to reconcile in-flight lifecycle events; URLs, headers, bodies,
 * initiator stacks, and response metadata are deliberately never stored.
 */
export class CdpNetworkActivityMonitor {
  private readonly inflight = new Set<string>();
  private started = false;
  private startedCount = 0;
  private finishedCount = 0;
  private failedCount = 0;
  private sequence = 0;

  private readonly onRequest = (params: any) => {
    const requestId = typeof params?.requestId === 'string' ? params.requestId : undefined;
    if (!requestId) return;
    if (!this.inflight.has(requestId)) {
      this.inflight.add(requestId);
      this.startedCount += 1;
    }
    this.sequence += 1;
  };

  private readonly onFinished = (params: any) => {
    const requestId = typeof params?.requestId === 'string' ? params.requestId : undefined;
    if (!requestId) return;
    if (this.inflight.delete(requestId)) this.finishedCount += 1;
    this.sequence += 1;
  };

  private readonly onFailed = (params: any) => {
    const requestId = typeof params?.requestId === 'string' ? params.requestId : undefined;
    if (!requestId) return;
    if (this.inflight.delete(requestId)) this.failedCount += 1;
    this.sequence += 1;
  };

  constructor(private readonly session: CdpEventSessionLike) {
    session.on('Network.requestWillBeSent', this.onRequest);
    session.on('Network.loadingFinished', this.onFinished);
    session.on('Network.loadingFailed', this.onFailed);
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.session.send('Network.enable');
    this.started = true;
  }

  summary(): NetworkActivitySummary {
    return {
      inFlight: this.inflight.size,
      started: this.startedCount,
      finished: this.finishedCount,
      failed: this.failedCount,
      activitySequence: this.sequence,
    };
  }

  async waitForIdle(options: NetworkIdleOptions = {}): Promise<NetworkIdleResult> {
    const quietMs = Math.max(0, options.quietMs ?? 100);
    const maxInflight = Math.max(0, Math.floor(options.maxInflight ?? 0));
    const timeoutMs = Math.max(0, options.timeoutMs ?? 2000);
    const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 25);
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? (() => Date.now());
    const startedAt = now();
    let quietStartedAt: number | undefined;
    let lastSequence = this.sequence;
    let samples = 0;

    while (true) {
      samples += 1;
      const current = this.summary();
      const timestamp = now();
      if (current.activitySequence !== lastSequence) {
        lastSequence = current.activitySequence;
        quietStartedAt = undefined;
      }
      if (current.inFlight <= maxInflight) {
        quietStartedAt ??= timestamp;
        if (timestamp - quietStartedAt >= quietMs) {
          return { idle: true, summary: current, elapsedMs: Math.max(0, timestamp - startedAt), samples };
        }
      } else {
        quietStartedAt = undefined;
      }
      const elapsedMs = Math.max(0, timestamp - startedAt);
      if (elapsedMs >= timeoutMs) {
        return { idle: false, summary: current, elapsedMs, samples };
      }
      await sleep(Math.min(pollIntervalMs, Math.max(0, timeoutMs - elapsedMs)));
    }
  }

  dispose(): void {
    this.session.off?.('Network.requestWillBeSent', this.onRequest);
    this.session.off?.('Network.loadingFinished', this.onFinished);
    this.session.off?.('Network.loadingFailed', this.onFailed);
    this.inflight.clear();
  }
}
