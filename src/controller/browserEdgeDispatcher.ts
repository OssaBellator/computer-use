import { effectiveTargetWidth } from '../geometry.js';
import type { BrowserInteractionObserver } from '../browser/cdpObserver.js';
import type { BrowserInput } from '../input/browserInput.js';
import type { InteractionEdge, InteractionNode, Point, Rect } from '../types.js';
import type { EdgeDispatchContext, EdgeDispatchResult } from './replanningExecutor.js';
import { PointerController } from './pointerController.js';

const KEY_FOR_KIND: Partial<Record<InteractionEdge['kind'], string>> = {
  'focus-next': 'Tab',
  'focus-previous': 'Shift+Tab',
  'spatial-up': 'ArrowUp',
  'spatial-down': 'ArrowDown',
  'spatial-left': 'ArrowLeft',
  'spatial-right': 'ArrowRight',
};

function focusedId(nodes: readonly InteractionNode[]): string | undefined {
  return nodes.find((node) => node.focused)?.id;
}

function targetRect(node: InteractionNode): Rect | undefined {
  return node.mainViewportVisibleRect ?? node.visibleRect ?? node.mainViewportRect ?? node.rect;
}

/** Concrete dispatcher for focus-navigation and pointer-acquisition graph edges. */
export class BrowserEdgeDispatcher {
  constructor(
    private readonly input: BrowserInput,
    private readonly pointer: PointerController,
    private readonly observer: BrowserInteractionObserver,
  ) {}

  readonly dispatch = async (
    edge: InteractionEdge,
    context: EdgeDispatchContext,
  ): Promise<EdgeDispatchResult> => {
    const key = KEY_FOR_KIND[edge.kind];
    if (key) return this.dispatchKeyboardNavigation(edge, context, key);
    if (edge.kind === 'pointer-move') return this.dispatchPointerMove(context.target);
    return { succeeded: false, arrivedNodeId: context.source.id, reason: `Unsupported edge kind: ${edge.kind}` };
  };

  private async dispatchKeyboardNavigation(
    edge: InteractionEdge,
    context: EdgeDispatchContext,
    key: string,
  ): Promise<EdgeDispatchResult> {
    await this.input.pressKey(key);
    const after = await this.observer.snapshot();
    const arrivedNodeId = focusedId(after);
    const succeeded = arrivedNodeId === context.target.id;

    if (arrivedNodeId && arrivedNodeId !== context.source.id &&
        (edge.kind === 'focus-next' || edge.kind === 'focus-previous')) {
      context.model.focusTopology.observe({
        fromId: context.source.id,
        toId: arrivedNodeId,
        direction: edge.kind === 'focus-next' ? 'forward' : 'backward',
      });
    }

    return {
      succeeded,
      arrivedNodeId: arrivedNodeId ?? context.source.id,
      reason: succeeded ? undefined : `Observed focus ${arrivedNodeId ?? '<none>'}, expected ${context.target.id}`,
    };
  }

  private async dispatchPointerMove(target: InteractionNode): Promise<EdgeDispatchResult> {
    const point = await this.observer.targetPoint(target);
    if (!point) return { succeeded: false, reason: `No hit-tested point for ${target.id}` };
    const rect = targetRect(target);
    const movement: Point = {
      x: point.x - this.pointer.touchpad.cursor.x,
      y: point.y - this.pointer.touchpad.cursor.y,
    };
    const width = rect ? effectiveTargetWidth(rect, movement) : 20;
    await this.pointer.moveTo(point, width);
    const succeeded = await this.observer.pointStillTargets(target, point);
    return {
      succeeded,
      arrivedNodeId: succeeded ? target.id : undefined,
      reason: succeeded ? undefined : `Pointer point no longer resolves to ${target.id}`,
    };
  }
}
