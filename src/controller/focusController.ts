import { FocusTopology, type FocusDirection, type FocusObservation } from '../focus/focusTopology.js';
import type { BrowserInput } from '../input/browserInput.js';
import type { InteractionNode } from '../types.js';

export type SnapshotProvider = () => Promise<readonly InteractionNode[]>;

export interface FocusStepResult {
  observation: FocusObservation | null;
  before: readonly InteractionNode[];
  after: readonly InteractionNode[];
}

function focusedId(nodes: readonly InteractionNode[]): string | null {
  return nodes.find((node) => node.focused)?.id ?? null;
}

/** Executes a sequential-focus action and learns the browser-observed result. */
export class FocusController {
  constructor(
    private readonly input: BrowserInput,
    private readonly snapshot: SnapshotProvider,
    readonly topology = new FocusTopology(),
  ) {}

  async step(direction: FocusDirection): Promise<FocusStepResult> {
    const before = await this.snapshot();
    const fromId = focusedId(before);
    await this.input.pressKey(direction === 'forward' ? 'Tab' : 'Shift+Tab');
    const after = await this.snapshot();
    const toId = focusedId(after);

    const observation = fromId && toId && fromId !== toId
      ? { fromId, toId, direction, observedAtMs: Date.now() }
      : null;
    if (observation) this.topology.observe(observation);
    return { observation, before, after };
  }
}
