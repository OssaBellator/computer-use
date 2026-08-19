import type { BrowserInteractionObserver } from '../browser/cdpObserver.js';
import type { BrowserInput } from '../input/browserInput.js';
import {
  InteractionModel,
  type ExplainedInteractionPlan,
  type InteractionModelPlanOptions,
} from '../model/interactionModel.js';
import {
  resolveInteractionTargetDetailed,
  type TargetQuery,
  type TargetResolution,
} from '../model/targetResolver.js';
import { VirtualTouchpad, type VirtualTouchpadOptions } from '../motor/virtualTouchpad.js';
import { PointerController, type PointerControllerOptions } from '../controller/pointerController.js';
import { BrowserEdgeDispatcher } from '../controller/browserEdgeDispatcher.js';
import { FocusController, type FocusStepResult } from '../controller/focusController.js';
import type { FocusDirection } from '../focus/focusTopology.js';
import { ReplanningExecutor, type ReplanningOptions, type ReplanningResult } from '../controller/replanningExecutor.js';
import {
  SemanticActionController,
  type ActivateTargetOptions,
  type SemanticActionResult,
  type SemanticActionStatus,
  type TypeIntoTargetOptions,
} from '../controller/semanticActionController.js';
import {
  ScrollRevealController,
  type ScrollRevealOptions,
  type ScrollRevealResult,
} from '../controller/scrollRevealController.js';
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
  autoReveal?: boolean;
  revealOptions?: ScrollRevealOptions;
  /** Refuse to dispatch input when equally preferred semantic matches exist. */
  requireUnambiguous?: boolean;
}

export interface AcquireResult {
  status: ReplanningResult['status'] | 'target-not-found' | 'target-ambiguous';
  target: InteractionNode | null;
  execution: ReplanningResult | null;
  resolution?: TargetResolution;
  reveal?: ScrollRevealResult;
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

function shouldAutoReveal(target: InteractionNode): boolean {
  return target.mainViewportVisible === false || target.viewportVisible === false;
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
  readonly revealController: ScrollRevealController;
  readonly focusController: FocusController;

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
    this.revealController = new ScrollRevealController(observer, input, this.pointer);
    this.focusController = new FocusController(
      input,
      () => this.observer.snapshot(),
      this.model.focusTopology,
    );
  }

  private async planningSnapshot(): Promise<InteractionNode[]> {
    const observed = [...await this.observer.snapshot()];
    const cursor = { x: this.touchpad.cursor.x, y: this.touchpad.cursor.y };
    this.model.setPointerPosition(cursor);
    return [cursorAnchor(cursor), ...observed];
  }

  async refresh(): Promise<InteractionNode[]> {
    const nodes = await this.planningSnapshot();
    this.model.refresh(nodes);
    return nodes.filter((node) => node.id !== CURSOR_ANCHOR_ID);
  }

  async resolve(query: TargetQuery | string): Promise<InteractionNode | null> {
    return (await this.resolveDetailed(query)).target;
  }

  async resolveDetailed(query: TargetQuery | string): Promise<TargetResolution> {
    const nodes = await this.refresh();
    return resolveInteractionTargetDetailed(nodes, query);
  }

  /** Observe one real browser Tab/Shift+Tab transition and add it to the shared model topology. */
  async observeFocus(direction: FocusDirection): Promise<FocusStepResult> {
    const result = await this.focusController.step(direction);
    this.model.refresh(result.after);
    return result;
  }

  async acquire(query: TargetQuery | string, options: AcquireOptions = {}): Promise<AcquireResult> {
    let nodes = await this.planningSnapshot();
    this.model.refresh(nodes);
    let resolution = resolveInteractionTargetDetailed(nodes, query);
    let target = resolution.target;
    if (!target) {
      return { status: 'target-not-found', target: null, execution: null, resolution };
    }
    if (options.requireUnambiguous && resolution.ambiguous) {
      return { status: 'target-ambiguous', target, execution: null, resolution };
    }

    let reveal: ScrollRevealResult | undefined;
    if (options.autoReveal !== false && shouldAutoReveal(target)) {
      const targetIdBeforeReveal = target.id;
      reveal = await this.revealController.reveal(target, options.revealOptions);
      if (reveal.status === 'revealed' || reveal.status === 'already-visible') {
        nodes = await this.planningSnapshot();
        this.model.refresh(nodes);
        resolution = resolveInteractionTargetDetailed(nodes, query);
        target = nodes.find((node) => node.id === targetIdBeforeReveal) ?? resolution.target;
        if (!target) {
          return { status: 'target-not-found', target: null, execution: null, resolution, reveal };
        }
        if (options.requireUnambiguous && resolution.ambiguous) {
          return { status: 'target-ambiguous', target, execution: null, resolution, reveal };
        }
      }
    }

    const focused = nodes.find((node) => node.focused);
    const startId = options.startId ?? focused?.id ?? CURSOR_ANCHOR_ID;
    const execution = await this.replanner.execute(startId, target.id, options);
    return {
      status: execution.status,
      target: this.model.getNode(target.id) ?? target,
      execution,
      resolution,
      ...(reveal ? { reveal } : {}),
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

  explainPlanTo(
    startId: string,
    targetId: string,
    options: InteractionModelPlanOptions = {},
  ): ExplainedInteractionPlan | null {
    return this.model.explainPlan(startId, targetId, options);
  }
}
