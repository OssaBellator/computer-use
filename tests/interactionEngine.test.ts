import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionEngine, CURSOR_ANCHOR_ID } from '../src/engine/interactionEngine.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { InteractionNode, Point } from '../src/types.js';

const target = (): InteractionNode => ({
  id: 'backend:7', structuralId: 'main:body > button:nth-of-type(1)', backendNodeId: 7,
  frameId: 'main', name: 'Target', role: 'button', focused: false, disabled: false,
  mainViewportRect: { x: 100, y: 20, width: 80, height: 30 },
  mainViewportVisibleRect: { x: 100, y: 20, width: 80, height: 30 }, mainViewportVisible: true,
  focusable: true, clickable: true, editable: false, scrollable: false,
  capabilities: ['focus', 'activate'], interactionConfidence: 1,
});

class Observer implements BrowserInteractionObserver {
  async snapshot() { return [target()]; }
  async targetPoint() { return { x: 140, y: 35 }; }
  async pointStillTargets() { return true; }
}
class Input implements BrowserInput {
  moves: Point[] = [];
  async movePointer(point: Point) { this.moves.push({ ...point }); }
  async pointerDown(_button?: MouseButton) {}
  async pointerUp(_button?: MouseButton) {}
  async pressKey(_key: string) {}
  async keyDown(_key: string) {}
  async keyUp(_key: string) {}
  async typeText(_text: string, _delayMs?: number) {}
  async scroll(_delta: Point) {}
}

test('engine resolves semantic target and acquires it from synthetic cursor anchor', async () => {
  const input = new Input();
  const engine = new InteractionEngine(new Observer(), input, {
    touchpadOptions: { initialCursor: { x: 0, y: 0 } },
    pointerOptions: { sleep: async () => {}, sampleIntervalMs: 100 },
  });
  const result = await engine.acquire({ name: 'Target', role: 'button' }, { includeDirectional: false });
  assert.equal(result.status, 'reached');
  assert.equal(result.target?.id, 'backend:7');
  assert.equal(result.execution?.executed[0].edge.from, CURSOR_ANCHOR_ID);
  assert.equal(result.execution?.executed[0].edge.kind, 'pointer-move');
  assert.deepEqual(input.moves.at(-1), { x: 140, y: 35 });
  assert.deepEqual(engine.model.getPointerPosition(), { x: 140, y: 35 });
});

test('engine reports target-not-found without dispatching input', async () => {
  const input = new Input();
  const engine = new InteractionEngine(new Observer(), input, { pointerOptions: { sleep: async () => {} } });
  const result = await engine.acquire({ name: 'Missing' });
  assert.equal(result.status, 'target-not-found');
  assert.equal(input.moves.length, 0);
});
