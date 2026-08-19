import type { CdpSessionLike } from '../browser/cdpIdentity.js';
import { createCdpRuntimeSnapshotPage } from '../browser/cdpRuntimePage.js';
import {
  createCdpBrowserAgentEngine,
  type CdpBrowserAgentEngine,
  type CdpBrowserAgentEngineOptions,
} from './cdpBrowserAgentEngine.js';
import {
  createCdpInteractionEngine,
  type CdpInteractionEngineOptions,
} from './cdpInteractionEngine.js';
import type { InteractionEngine } from './interactionEngine.js';

/** Build the semantic interaction engine using only a page-target CDP session. */
export async function createPureCdpInteractionEngine(
  session: CdpSessionLike,
  options: CdpInteractionEngineOptions = {},
): Promise<InteractionEngine> {
  const page = await createCdpRuntimeSnapshotPage(session);
  return createCdpInteractionEngine(page, session, options);
}

/** Build the full browser-agent facade without a Playwright/Puppeteer page object. */
export async function createPureCdpBrowserAgentEngine(
  session: CdpSessionLike,
  options: CdpBrowserAgentEngineOptions = {},
): Promise<CdpBrowserAgentEngine> {
  const page = await createCdpRuntimeSnapshotPage(session);
  return createCdpBrowserAgentEngine(page, session, options);
}
