import { CdpInteractionObserver } from '../browser/cdpObserver.js';
import { CoalescingInteractionObserver } from '../browser/coalescingObserver.js';
import type { CdpSessionLike } from '../browser/cdpIdentity.js';
import type { SnapshotPageLike } from '../browser/domSnapshot.js';
import { CdpInputAdapter } from '../input/cdpInputAdapter.js';
import { InteractionEngine, type InteractionEngineOptions } from './interactionEngine.js';

export interface CdpInteractionEngineOptions extends InteractionEngineOptions {
  /** Collapse only overlapping in-flight full snapshots; completed observations are never cached. */
  coalesceSnapshots?: boolean;
}

export function createCdpInteractionEngine(
  page: SnapshotPageLike,
  session: CdpSessionLike,
  options: CdpInteractionEngineOptions = {},
): InteractionEngine {
  const sourceObserver = new CdpInteractionObserver(page, session);
  const observer = options.coalesceSnapshots === false
    ? sourceObserver
    : new CoalescingInteractionObserver(sourceObserver);
  const { coalesceSnapshots: _coalesceSnapshots, ...engineOptions } = options;
  return new InteractionEngine(
    observer,
    new CdpInputAdapter(session),
    engineOptions,
  );
}
