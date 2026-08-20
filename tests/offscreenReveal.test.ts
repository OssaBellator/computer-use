import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionEngine } from '../src/engine/interactionEngine.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { InteractionNode, Point } from '../src/types.js';

class Observer implements BrowserInteractionObserver {
  visible = false;
  target(): InteractionNode {
    return {
      id: 'backend:99',
      structuralId: 'main:body:nth-of-type(1) > button:nth-of-type(1)',
      backendNodeId: 99,
      frameId: 'main',
      name: 'Below fold',
      role: 'button',
      focused: false,
      disabled: false,
      rect: { x: 100, y: this.visible ? 200 : 1800, width: 120, height: 40 },
      mainViewportRect: { x: 100, y: this.visible ? 200 : 1800, width: 120, height: 40 },
      mainViewportVisibleRect: this.visible ? { x: 100, y: 200, width: 120, height: 40 } : undefined,
      mainViewportVisible: this.visible,
      viewportVisible: this.visible,
      focusable: true,
      clickable: true,
      editable: false,
      scrollable: false,
      capabilities: ['focus', 'activate'],
      interactionConfidence: 1,
    };
  }
  async snapshot() { return [this.target()]; }
  async targetPoint() { return this.visible ? { x: 160, y: 220 } : null; }
  async pointStillTargets() { return this.visible; }
  async viewportRect() { return { x: 0, y: 0, width: 800, height: 600 }; }
}

class Input implements BrowserInput {
  scrolls: Point[] = [];
  constructor(private readonly observer: Observer) {}
  async movePointer(_point: Point) {}
  async pointerDown(_button?: MouseButton) {}
  async pointerUp(_button?: MouseButton) {}
  async pressKey(_key: string) {}
  async keyDown(_key: string) {}
  async keyUp(_key: string) {}
  async typeText(_text: string, _delayMs?: number) {}
  async scroll(delta: Point) {
    this.scrolls.push({ ...delta });
    this.observer.visible = true;
  }
}

test('acquire reveals an offscreen target with wheel input before pointer planning', async () => {
  const observer = new Observer();
  const input = new Input(observer);
  const engine = new InteractionEngine(observer, input, {
    pointerOptions: { sleep: async () => {}, sampleIntervalMs: 100 },
  });
  const result = await engine.acquire(
    { name: 'Below fold' },
    {
      includeDirectional: false,
      revealOptions: { maxSamples: 1, sleep: async () => {} },
    },
  );
  assert.equal(result.status, 'reached');
  assert.equal(result.reveal?.status, 'revealed');
  assert.ok(input.scrolls.length > 0);
  assert.equal(result.target?.id, 'backend:99');
});
