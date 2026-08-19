import { effectiveTargetWidth } from '../geometry.js';
import type { Direction } from '../graph.js';
import type { BrowserInteractionObserver } from '../browser/cdpObserver.js';
import {
  compositeAnchorIsCurrent,
  focusedCompositeState,
} from '../focus/compositeState.js';
import type { FocusDirection } from '../focus/focusTopology.js';
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

const DIRECTION_FOR_KIND: Partial<Record<InteractionEdge['kind'], Direction>> = {
  'spatial-up': 'up',
  'spatial-down': 'down',
  'spatial-left': 'left',
  'spatial-right': 'right',
};

function focusedId(nodes: readonly InteractionNode[]): string | undefined {
  return nodes.find((node) => node.focused)?.id;
}

function navigationArrival(
  nodes: readonly InteractionNode[],
  edge: InteractionEdge,
): string | undefined {
  if (DIRECTION_FOR_KIND[edge.kind]) {
    return focusedCompositeState(nodes)?.active.id ?? focusedId(nodes);
  }
  return focusedId(nodes);
}

function focusDirection(edge: InteractionEdge, key: string): FocusDirection | undefined {
  if (edge.kind === 'focus-next') return 'forward';
  if (edge.kind === 'focus-previous') return 'backward';
  if (edge.kind === 'enter-frame' || edge.kind === 'exit-frame') {
    return key === 'Shift+Tab' ? 'backward' : 'forward';
  }
  return undefined;
}

function targetRect(node: InteractionNode): Rect | undefined {
  return node.mainViewportVisibleRect ?? node.visibleRect ?? node.mainViewportRect ?? node.rect;
}

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
    if (edge.kind === 'state-anchor') return this.dispatchStateAnchor(context);
    const key = edge.keyboardKey ?? KEY_FOR_KIND[edge.kind];
    if (key) return this.dispatchKeyboardNavigation(edge, context, key);
    if (edge.kind === 'pointer-move') return this.dispatchPointerMove(context);
    return {
      succeeded: false,
      arrivedNodeId: context.source.id,
      reason: `Unsupported edge kind: ${edge.kind}`,
    };
  };

  private async dispatchStateAnchor(context: EdgeDispatchContext): Promise<EdgeDispatchResult> {
    const after = await this.observer.snapshot();
    const succeeded = compositeAnchorIsCurrent(after, context.source.id, context.target.id);
    return {
      succeeded,
      arrivedNodeId: succeeded ? context.target.id : context.source.id,
      reason: succeeded
        ? undefined
        : `Composite logical state no longer bridges ${context.source.id} -> ${context.target.id}`,
    };
  }

  private async dispatchKeyboardNavigation(
    edge: InteractionEdge,
    context: EdgeDispatchContext,
    key: string,
  ): Promise<EdgeDispatchResult> {
    await this.input.pressKey(key);
    const after = await this.observer.snapshot();
    const arrivedNodeId = navigationArrival(after, edge);
    const succeeded = arrivedNodeId === context.target.id;

    if (arrivedNodeId && arrivedNodeId !== context.source.id) {
      const learnedFocusDirection = focusDirection(edge, key);
      if (learnedFocusDirection) {
        context.model.focusTopology.observe({
          fromId: context.source.id,
          toId: arrivedNodeId,
          direction: learnedFocusDirection,
        });
      } else {
        const direction = DIRECTION_FOR_KIND[edge.kind];
        if (direction) {
          context.model.directionalTopology.observe({
            fromId: context.source.id,
            toId: arrivedNodeId,
            direction,
          });
        }
      }
    }

    return {
      succeeded,
      arrivedNodeId: arrivedNodeId ?? context.source.id,
      reason: succeeded
        ? undefined
        : `Observed navigation state ${arrivedNodeId ?? '<none>'}, expected ${context.target.id}`,
    };
  }

  private async dispatchPointerMove(context: EdgeDispatchContext): Promise<EdgeDispatchResult> {
    const target = context.target;
    const point = await this.observer.targetPoint(target);
    if (!point) return { succeeded: false, reason: `No hit-tested point for ${target.id}` };
    const rect = targetRect(target);
    const movement: Point = {
      x: point.x - this.pointer.touchpad.cursor.x,
      y: point.y - this.pointer.touchpad.cursor.y,
    };
    const width = rect ? effectiveTargetWidth(rect, movement) : 20;
    await this.pointer.moveTo(point, width);
    context.model.setPointerPosition(this.pointer.touchpad.cursor);
    const succeeded = await this.observer.pointStillTargets(target, point);
    return {
      succeeded,
      arrivedNodeId: succeeded ? target.id : undefined,
      reason: succeeded ? undefined : `Pointer point no longer resolves to ${target.id}`,
    };
  }
}
