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
  /** Consecutive snapshot failures tolerated before returning unmatched. */
  maxConsecutiveErrors?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface ObservationWaitResult {
  after: readonly InteractionNode[];
  delta: SnapshotDelta;
  matched: boolean;
  /** Number of successful snapshots collected. */
  samples: number;
  /** Snapshot-provider failures observed while settling. */
  observationErrors: number;
  /** True when settling stopped because the consecutive-error budget was exceeded. */
  errorBudgetExhausted: boolean;
  elapsedMs: number;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function result(
  latest: readonly InteractionNode[],
  latestDelta: SnapshotDelta,
  matched: boolean,
  samples: number,
  observationErrors: number,
  errorBudgetExhausted: boolean,
  elapsedMs: number,
): ObservationWaitResult {
  return {
    after: latest,
    delta: latestDelta,
    matched,
    samples,
    observationErrors,
    errorBudgetExhausted,
    elapsedMs,
  };
}

/**
 * Polls browser state until a caller-defined observable condition is satisfied.
 *
 * Cross-document actions can transiently destroy execution contexts. A small,
 * bounded number of snapshot failures is therefore tolerated by default. An
 * exhausted error budget returns the latest known state as *unmatched*; missing
 * evidence is never converted into success.
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
  const maxConsecutiveErrors = Math.max(0, Math.floor(options.maxConsecutiveErrors ?? 3));
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? (() => Date.now());
  const startedAt = now();
  let samples = 0;
  let observationErrors = 0;
  let consecutiveErrors = 0;
  let latest = before;
  let latestDelta = diffSnapshots(before, before);

  while (samples < maxSamples) {
    try {
      latest = await snapshot();
      samples += 1;
      consecutiveErrors = 0;
      latestDelta = diffSnapshots(before, latest);
      const elapsedMs = Math.max(0, now() - startedAt);
      if (predicate(latestDelta, latest)) {
        return result(latest, latestDelta, true, samples, observationErrors, false, elapsedMs);
      }
      if (elapsedMs >= timeoutMs || samples >= maxSamples) {
        return result(latest, latestDelta, false, samples, observationErrors, false, elapsedMs);
      }
    } catch {
      observationErrors += 1;
      consecutiveErrors += 1;
      const elapsedMs = Math.max(0, now() - startedAt);
      if (consecutiveErrors > maxConsecutiveErrors) {
        return result(latest, latestDelta, false, samples, observationErrors, true, elapsedMs);
      }
      if (elapsedMs >= timeoutMs) {
        return result(latest, latestDelta, false, samples, observationErrors, false, elapsedMs);
      }
    }

    const elapsedMs = Math.max(0, now() - startedAt);
    const remaining = Math.max(0, timeoutMs - elapsedMs);
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  return result(
    latest,
    latestDelta,
    false,
    samples,
    observationErrors,
    false,
    Math.max(0, now() - startedAt),
  );
}
