import { describeSnapshotFrames } from '../browser/cdpIdentity.js';
import {
  snapshotInteractiveDom,
  type SnapshotPageLike,
} from '../browser/domSnapshot.js';
import {
  buildInteractionFrameHierarchy,
  enrichInteractionNodesWithFrameHierarchy,
} from '../browser/frameHierarchy.js';
import { FocusTopology, type FocusDirection, type FocusObservation } from '../focus/focusTopology.js';
import type { BrowserInput } from '../input/browserInput.js';
import type { InteractionNode } from '../types.js';

export type SnapshotProvider = () => Promise<readonly InteractionNode[]>;

export interface FocusStepResult {
  observation: FocusObservation | null;
  beforeFocusId: string | null;
  afterFocusId: string | null;
  before: readonly InteractionNode[];
  after: readonly InteractionNode[];
}

function focusedId(nodes: readonly InteractionNode[]): string | null {
  return nodes.find((node) => node.focused)?.id ?? null;
}

function isSnapshotPageLike(value: BrowserInput | SnapshotPageLike): value is SnapshotPageLike {
  return typeof (value as SnapshotPageLike).frames === 'function';
}

function pageSnapshotProvider(page: SnapshotPageLike): SnapshotProvider {
  return async () => enrichInteractionNodesWithFrameHierarchy(
    await snapshotInteractiveDom(page),
    buildInteractionFrameHierarchy(describeSnapshotFrames(page)),
  );
}

/** Executes sequential-focus actions and learns browser-observed transitions. */
export class FocusController {
  private readonly input: BrowserInput;
  private readonly snapshot: SnapshotProvider;
  readonly topology: FocusTopology;

  constructor(
    input: BrowserInput,
    snapshot: SnapshotProvider,
    topology?: FocusTopology,
  );
  constructor(
    page: SnapshotPageLike,
    input: BrowserInput,
    topology?: FocusTopology,
  );
  constructor(
    inputOrPage: BrowserInput | SnapshotPageLike,
    snapshotOrInput: SnapshotProvider | BrowserInput,
    topology = new FocusTopology(),
  ) {
    if (isSnapshotPageLike(inputOrPage)) {
      this.input = snapshotOrInput as BrowserInput;
      this.snapshot = pageSnapshotProvider(inputOrPage);
    } else {
      this.input = inputOrPage;
      this.snapshot = snapshotOrInput as SnapshotProvider;
    }
    this.topology = topology;
  }

  async step(direction: FocusDirection): Promise<FocusStepResult> {
    const before = await this.snapshot();
    const beforeFocusId = focusedId(before);
    await this.input.pressKey(direction === 'forward' ? 'Tab' : 'Shift+Tab');
    const after = await this.snapshot();
    const afterFocusId = focusedId(after);

    const observation = beforeFocusId && afterFocusId && beforeFocusId !== afterFocusId
      ? { fromId: beforeFocusId, toId: afterFocusId, direction, observedAtMs: Date.now() }
      : null;
    if (observation) this.topology.observe(observation);
    return { observation, beforeFocusId, afterFocusId, before, after };
  }
}
