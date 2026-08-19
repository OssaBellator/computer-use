import test from 'node:test';
import assert from 'node:assert/strict';
import { InteractionEngine, CURSOR_ANCHOR_ID } from '../src/engine/interactionEngine.js';
import type { BrowserInteractionObserver } from '../src/browser/cdpObserver.js';
import type { BrowserInput, MouseButton } from '../src/input/browserInput.js';
import type { InteractionNode, Point } from '../src/types.js';

const target = (id = 'backend:7', name = 'Target'): InteractionNode => ({
  id, structuralId: `main:body > button:nth-of-type(${id === 'backend:7' ? 1 : 2})`,
  backendNodeId: Number(id.split(':')[1]) || undefined,
  frameId: 'main', name, role: 'button', focused: false, disabled: false,
  mainViewportRect: { x: 100, y: 20, width: 80, height: 30 },
  mainViewportVisibleRect: { x: 100, y: 20, width: 80, height: 30 }, mainViewportVisible: true,
  focusable: true, clickable: true, editable: false, scrollable: false,
  capabilities: ['focus', 'activate'], interactionConfidence: 1,
});

class Observer implements BrowserInteractionObserver {
  constructor(readonly nodes: InteractionNode[] = [target()]) {}
  async snapshot() { return this.nodes.map((node) => ({ ...node })); }
  async targetPoint(node: InteractionNode) {
    const rect = node.mainViewportRect!;
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }
  async pointStillTargets() { return true; }
}
class Input implements BrowserInput {
  moves: Point[] = [];
  async movePointer(point: Point) { this.moves.push({ x: point.x, y: point.y }); }
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
  assert.equal(result.resolution?.ambiguous, false);
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
  assert.equal(result.resolution?.candidates.length, 0);
  assert.equal(input.moves.length, 0);
});

test('resolveDetailed exposes equally preferred semantic matches', async () => {
  const input = new Input();
  const engine = new InteractionEngine(
    new Observer([target('backend:7', 'Delete'), target('backend:8', 'Delete')]),
    input,
    { pointerOptions: { sleep: async () => {} } },
  );
  const resolution = await engine.resolveDetailed({ name: 'Delete', role: 'button' });
  assert.equal(resolution.ambiguous, true);
  assert.deepEqual(resolution.equallyPreferred.map((node) => node.id), ['backend:7', 'backend:8']);
});

test('requireUnambiguous refuses to dispatch input for tied semantic matches', async () => {
  const input = new Input();
  const engine = new InteractionEngine(
    new Observer([target('backend:7', 'Delete'), target('backend:8', 'Delete')]),
    input,
    { pointerOptions: { sleep: async () => {} } },
  );
  const result = await engine.acquire(
    { name: 'Delete', role: 'button' },
    { includeDirectional: false, requireUnambiguous: true },
  );
  assert.equal(result.status, 'target-ambiguous');
  assert.equal(result.resolution?.ambiguous, true);
  assert.equal(result.execution, null);
  assert.deepEqual(input.moves, []);
});
