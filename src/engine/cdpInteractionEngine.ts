import { CdpInteractionObserver } from '../browser/cdpObserver.js';
import type { CdpSessionLike } from '../browser/cdpIdentity.js';
import type { SnapshotPageLike } from '../browser/domSnapshot.js';
import { CdpInputAdapter } from '../input/cdpInputAdapter.js';
import { InteractionEngine, type InteractionEngineOptions } from './interactionEngine.js';

export function createCdpInteractionEngine(
  page: SnapshotPageLike,
  session: CdpSessionLike,
  options: InteractionEngineOptions = {},
): InteractionEngine {
  return new InteractionEngine(
    new CdpInteractionObserver(page, session),
    new CdpInputAdapter(session),
    options,
  );
}
