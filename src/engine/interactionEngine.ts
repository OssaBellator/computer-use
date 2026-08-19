import type { BrowserInteractionObserver } from '../browser/cdpObserver.js';
import type { BrowserInput } from '../input/browserInput.js';
import { InteractionModel, type InteractionModelPlanOptions } from '../model/interactionModel.js';
import { resolveInteractionTarget, type TargetQuery } from '../model/targetResolver.js';
import { VirtualTouchpad, type VirtualTouchpadOptions } from '../motor/virtualTouchpad.js';
import { PointerController, type PointerControllerOptions } from '../controller/pointerController.js';
import { BrowserEdgeDispatcher } from '../controller/browserEdgeDispatcher.js';
import { ReplanningExecutor, type ReplanningOptions, type ReplanningResult } from '../controller/replanningExecutor.js';
import {
  SemanticActionController,
  type ActivateTargetOptions,
  type SemanticActionResult,
  type SemanticActionStatus,
  type TypeIntoTargetOptions,
} from '../controller/semanticActionController.js';
import type { InteractionNode, Point } from '../types.js';

export const CURSOR_ANCHOR_ID = '@cursor';

export interface InteractionEngineOptions {
  model?: InteractionModel;
  touchpad?: VirtualTouchpad;
  touchpadOptions?: VirtualTouchpadOptions;
  pointerOptions?: PointerControllerOptions;
}

export interface AcquireOptions extends ReplanningOptions {
  startId?: string;
}

export interface AcquireResult {
  status: ReplanningResult['status'] | 'target-not-found';
  target: InteractionNode | null;
  execution: ReplanningResult | null;
}

export interface EngineActivateOptions extends AcquireOptions, ActivateTargetOptions {}
export interface EngineTypeIntoOptions extends AcquireOptions, TypeIntoTargetOptions {}

export interface EngineSemanticActionResult {
  status: AcquireResult['status'] | SemanticActionStatus;
  target: InteractionNode | null;
  acquisition: AcquireResult;
  action: SemanticActionResult | null;
}

function cursorAnchor(point: Point): InteractionNode {
  return {
    id: CURSOR_ANCHOR_ID,
    frameId: 'main',
    focused: false,
    disabled: false,
    rect: { x: point.x, y: point.y, width: 1, height: 1 },
    visibleRect: { x: point.x, y: point.y, width: 1, height: 1 },
    viewportVisible: true,
    mainViewportRect: { x: point.x, y: point.y, width: 1, height: 1 },
    mainViewportVisibleRect: { x: point.x, y: point.y, width: 1, height: 1 },
    mainViewportVisible: true,
    focusable: false,
    clickable: false,
    editable: false,
    scrollable: false,
    capabilities: [],
    interactionConfidence: 1,
  };
}

/**
 * High-level closed-loop facade that keeps semantic page state, physical
 * pointer state, planning, dispatch, observation, and replanning together.
 */
export class InteractionEngine {
  readonly model: InteractionModel;
  readonly touchpad: VirtualTouchpad;
  readonly pointer: PointerController;
  readonly dispatcher: BrowserEdgeDispatcher;
  readonly replanner: ReplanningExecutor;
  readonly actions: SemanticActionController;

  constructor(
    readonly observer: BrowserInteractionObserver,
    readonly input: BrowserInput,
    options: InteractionEngineOptions = {},
  ) {
    this.model = options.model ?? new InteractionModel();
    this.touchpad = options.touchpad ?? new VirtualTouchpad(options.touchpadOptions);
    this.pointer = new PointerController(input, this.touchpad, options.pointerOptions);
    this.dispatcher = new BrowserEdgeDispatcher(input, this.pointer, observer);
    this.replanner = new ReplanningExecutor(this.model, () => this.planningSnapshot(), this.dispatcher.dispatch);
    this.actions = new SemanticActionController(observer, input, this.pointer);
  }

  private async planningSnapshot(): Promise<InteractionNode[]> {
    const observed = [...await this.observer.snapshot()];
    const cursor = { ...this.touchpad.cursor };
    this.model.setPointerPosition(cursor);
    return [cursorAnchor(cursor), ...observed];
  }

  async refresh(): Promise<InteractionNode[]> {
    const nodes = await this.planningSnapshot();
    this.model.refresh(nodes);
    return nodes.filter((node) => node.id !== CURSOR_ANCHOR_ID);
  }

  async resolve(query: TargetQuery | string): Promise<InteractionNode | null> {
    const nodes = await this.refresh();
    return resolveInteractionTarget(nodes, query);
  }

  async acquire(query: TargetQuery | string, options: AcquireOptions = {}): Promise<AcquireResult> {
    const nodes = await this.planningSnapshot();
    this.model.refresh(nodes);
    const target = resolveInteractionTarget(nodes, query);
    if (!target) return { status: 'target-not-found', target: null, execution: null };

    const focused = nodes.find((node) => node.focused);
    const startId = options.startId ?? focused?.id ?? CURSOR_ANCHOR_ID;
    const execution = await this.replanner.execute(startId, target.id, options);
    return {
      status: execution.status,
      target: this.model.getNode(target.id) ?? target,
      execution,
    };
  }

  async activate(
    query: TargetQuery | string,
    options: EngineActivateOptions = {},
  ): Promise<EngineSemanticActionResult> {
    const acquisition = await this.acquire(query, options);
    if (acquisition.status !== 'reached' || !acquisition.target) {
      return {
        status: acquisition.status,
        target: acquisition.target,
        acquisition,
        action: null,
      };
    }
    const action = await this.actions.activate(acquisition.target, options);
    return { status: action.status, target: action.target, acquisition, action };
  }

  async typeInto(
    query: TargetQuery | string,
    text: string,
    options: EngineTypeIntoOptions = {},
  ): Promise<EngineSemanticActionResult> {
    const acquisition = await this.acquire(query, options);
    if (acquisition.status !== 'reached' || !acquisition.target) {
      return {
        status: acquisition.status,
        target: acquisition.target,
        acquisition,
        action: null,
      };
    }
    const action = await this.actions.typeInto(acquisition.target, text, options);
    return { status: action.status, target: action.target, acquisition, action };
  }

  planTo(startId: string, targetId: string, options: InteractionModelPlanOptions = {}) {
    return this.model.plan(startId, targetId, options);
  }
}
