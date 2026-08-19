import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionEngine } from '../src/engine/interactionEngine.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { InteractionNode, Point } from '../src/types.js';

class MutableObserver implements BrowserInteractionObserver {
  revealed = false;
  expanded = false;
  private node(): InteractionNode {
    const y = this.revealed ? 50 : 140;
    return {
      id: 'backend:9',
      structuralId: 'main:body > button:nth-of-type(1)',
      backendNodeId: 9,
      frameId: 'main',
      name: 'Action',
      role: 'button',
      focused: false,
      disabled: false,
      expanded: this.expanded,
      mainViewportRect: { x: 20, y, width: 60, height: 20 },
      mainViewportVisibleRect: this.revealed ? { x: 20, y, width: 60, height: 20 } : undefined,
      mainViewportVisible: this.revealed,
      focusable: true,
      clickable: true,
      editable: false,
      scrollable: false,
      capabilities: ['focus', 'activate', 'expand'],
      interactionConfidence: 1,
    };
  }
  async snapshot() { return [this.node()]; }
  async targetPoint() { return this.revealed ? { x: 50, y: 60 } : null; }
  async pointStillTargets() { return this.revealed; }
  async viewportRect() { return { x: 0, y: 0, width: 100, height: 100 }; }
}

class MutableInput implements BrowserInput {
  readonly moves: Point[] = [];
  readonly scrolls: Point[] = [];
  readonly buttons: string[] = [];
  constructor(readonly observer: MutableObserver) {}
  async movePointer(point: Point) { this.moves.push({ x: point.x, y: point.y }); }
  async pointerDown(button: MouseButton = 'left') { this.buttons.push(`down:${button}`); }
  async pointerUp(button: MouseButton = 'left') {
    this.buttons.push(`up:${button}`);
    this.observer.expanded = true;
  }
  async pressKey(_key: string) {}
  async keyDown(_key: string) {}
  async keyUp(_key: string) {}
  async typeText(_text: string, _delayMs?: number) {}
  async scroll(delta: Point) {
    this.scrolls.push({ ...delta });
    this.observer.revealed = true;
  }
}

function engineFixture() {
  const observer = new MutableObserver();
  const input = new MutableInput(observer);
  const engine = new InteractionEngine(observer, input, {
    touchpadOptions: { initialCursor: { x: 0, y: 0 } },
    pointerOptions: { sleep: async () => {}, sampleIntervalMs: 100 },
  });
  return { observer, input, engine };
}

test('engine auto-reveals an offscreen target before pointer acquisition', async () => {
  const { engine, input } = engineFixture();
  const result = await engine.acquire('Action', {
    includeDirectional: false,
    revealOptions: { maxSamples: 1, sleep: async () => {}, marginPx: 10 },
  });

  assert.equal(result.status, 'reached');
  assert.equal(result.reveal?.status, 'revealed');
  assert.deepEqual(input.scrolls, [{ x: 0, y: 70 }]);
  assert.deepEqual(input.moves.at(-1), { x: 50, y: 60 });
});

test('engine activate continues from acquisition into verified semantic state change', async () => {
  const { engine, input } = engineFixture();
  const result = await engine.activate('Action', {
    includeDirectional: false,
    revealOptions: { maxSamples: 1, sleep: async () => {}, marginPx: 10 },
    maxSamples: 1,
    sleep: async () => {},
  });

  assert.equal(result.acquisition.status, 'reached');
  assert.equal(result.status, 'verified');
  assert.equal(result.action?.delta.changedStates[0].field, 'expanded');
  assert.deepEqual(input.buttons, ['down:left', 'up:left']);
});
