import { captureCdpBrowserState, type BrowserStateSnapshot } from '../browser/browserState.js';
import type { CdpSessionLike } from '../browser/cdpIdentity.js';
import {
  CdpNavigationController,
  type BrowserNavigationOptions,
  type BrowserNavigationResult,
  type BrowserNavigator,
} from '../browser/navigationController.js';
import type { SnapshotPageLike } from '../browser/domSnapshot.js';
import type { TargetQuery } from '../model/targetResolver.js';
import type { InteractionNode } from '../types.js';
import type { TaskRuntimeEngine, TaskEngineActionResult } from '../agent/taskRuntime.js';
import {
  createCdpInteractionEngine,
  type CdpInteractionEngineOptions,
} from './cdpInteractionEngine.js';
import type { InteractionEngine } from './interactionEngine.js';

/**
 * Task-runtime facade that composes the existing semantic interaction engine
 * with browser-level state and navigation primitives from the same CDP session.
 */
export class CdpBrowserAgentEngine implements TaskRuntimeEngine {
  constructor(
    readonly interaction: InteractionEngine,
    private readonly session: CdpSessionLike,
    readonly navigator: BrowserNavigator = new CdpNavigationController(session),
  ) {}

  refresh(): Promise<InteractionNode[]> {
    return this.interaction.refresh();
  }

  browserState(): Promise<BrowserStateSnapshot> {
    return captureCdpBrowserState(this.session);
  }

  activate(
    query: TargetQuery | string,
    options?: Parameters<InteractionEngine['activate']>[1],
  ): Promise<TaskEngineActionResult> {
    return this.interaction.activate(query, options);
  }

  typeInto(
    query: TargetQuery | string,
    text: string,
    options?: Parameters<InteractionEngine['typeInto']>[2],
  ): Promise<TaskEngineActionResult> {
    return this.interaction.typeInto(query, text, options);
  }

  navigate(url: string, options?: BrowserNavigationOptions): Promise<BrowserNavigationResult> {
    return this.navigator.navigate(url, options);
  }
}

export function createCdpBrowserAgentEngine(
  page: SnapshotPageLike,
  session: CdpSessionLike,
  options: CdpInteractionEngineOptions = {},
): CdpBrowserAgentEngine {
  return new CdpBrowserAgentEngine(
    createCdpInteractionEngine(page, session, options),
    session,
  );
}
