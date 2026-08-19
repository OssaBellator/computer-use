import type { InteractionNode } from '../types.js';
import {
  diffSnapshots,
  snapshotDeltaHasObservableChange,
  type SnapshotDelta,
} from './actionVerifier.js';

export type ObservationSnapshotProvider = () => Promise<readonly InteractionNode[]>;
export type ObservationPredicate = (
  delta: SnapshotDelta,
  after: readonly InteractionNode[],
) => boolean;

export interface ObservationWaitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  maxSamples?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ObservationWaitResult {
  after: readonly InteractionNode[];
  delta: SnapshotDelta;
  matched: boolean;
  samples: number;
  elapsedMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls the browser model after an action until a caller-defined observable
 * condition is satisfied. A timeout returns the latest observation rather than
 * converting an unverified command into success.
 */
export async function waitForObservation(
  snapshot: ObservationSnapshotProvider,
  before: readonly InteractionNode[],
  predicate: ObservationPredicate = snapshotDeltaHasObservableChange,
  options: ObservationWaitOptions = {},
): Promise<ObservationWaitResult> {
  const timeoutMs = Math.max(0, options.timeoutMs ?? 500);
  const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 25);
  const maxSamples = Math.max(1, options.maxSamples ?? 100);
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  let samples = 0;
  let latest = before;
  let latestDelta = diffSnapshots(before, before);

  while (samples < maxSamples) {
    latest = await snapshot();
    samples += 1;
    latestDelta = diffSnapshots(before, latest);
    const elapsedMs = Math.max(0, now() - startedAt);
    if (predicate(latestDelta, latest)) {
      return { after: latest, delta: latestDelta, matched: true, samples, elapsedMs };
    }
    if (elapsedMs >= timeoutMs || samples >= maxSamples) {
      return { after: latest, delta: latestDelta, matched: false, samples, elapsedMs };
    }
    const remaining = Math.max(0, timeoutMs - elapsedMs);
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  return {
    after: latest,
    delta: latestDelta,
    matched: false,
    samples,
    elapsedMs: Math.max(0, now() - startedAt),
  };
}
