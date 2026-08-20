import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpDragDropController } from '../src/browser/cdpDragDropController.js';

class FakeDragSession {
  readonly calls: Array<[string, Record<string, unknown> | undefined]> = [];
  private readonly listeners = new Map<string, Set<(params: any) => void>>();
  pressed = false;
  emitted = false;
  dragData: any = {
    items: [{ mimeType: 'text/plain', data: 'private-transfer-text', title: '', baseURL: '' }],
    files: [],
    dragOperationsMask: 1,
  };

  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    this.calls.push([method, params]);
    if (method === 'Input.dispatchMouseEvent') {
      if (params?.type === 'mousePressed') this.pressed = true;
      if (params?.type === 'mouseMoved' && this.pressed && !this.emitted) {
        this.emitted = true;
        queueMicrotask(() => {
          for (const listener of this.listeners.get('Input.dragIntercepted') ?? []) {
            listener({ data: this.dragData });
          }
        });
      }
      if (params?.type === 'mouseReleased') this.pressed = false;
    }
    return {};
  }

  on(event: string, listener: (params: any) => void): void {
    const listeners = this.listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.listeners.set(event, listeners);
  }

  off(event: string, listener: (params: any) => void): void {
    this.listeners.get(event)?.delete(listener);
  }
}

function dragTypes(session: FakeDragSession): unknown[] {
  return session.calls
    .filter(([method]) => method === 'Input.dispatchDragEvent')
    .map(([, params]) => params?.type);
}

test('native intercepted drag data is dispatched without returning payload text', async () => {
  const session = new FakeDragSession();
  const result = await new CdpDragDropController(session).transfer(
    { x: 10, y: 20 },
    { x: 200, y: 220 },
    { interceptTimeoutMs: 50 },
  );

  assert.equal(result.status, 'drop-dispatched');
  assert.equal(result.itemCount, 1);
  assert.equal(result.fileCount, 0);
  assert.deepEqual(result.mimeTypes, ['text/plain']);
  assert.equal(JSON.stringify(result).includes('private-transfer-text'), false);
  assert.deepEqual(dragTypes(session), ['dragEnter', 'dragOver', 'drop']);
  assert.equal(session.calls.at(-1)?.[0], 'Input.setInterceptDrags');
  assert.equal(session.calls.at(-1)?.[1]?.enabled, false);
  assert.equal(session.pressed, false);
});

test('oversized intercepted drag payload is canceled before dragEnter/drop dispatch', async () => {
  const session = new FakeDragSession();
  session.dragData = {
    items: [{ mimeType: 'text/plain', data: 'x'.repeat(128), title: '', baseURL: '' }],
    files: [],
    dragOperationsMask: 1,
  };
  const result = await new CdpDragDropController(session).transfer(
    { x: 10, y: 20 },
    { x: 200, y: 220 },
    { maxPayloadBytes: 32, interceptTimeoutMs: 50 },
  );

  assert.equal(result.status, 'payload-blocked');
  assert.equal(result.totalPayloadBytes > 32, true);
  assert.deepEqual(dragTypes(session), ['dragCancel']);
  assert.equal(session.pressed, false);
});

test('file-bearing drag payloads are canceled unless explicitly enabled', async () => {
  const blockedSession = new FakeDragSession();
  blockedSession.dragData = {
    items: [{ mimeType: 'text/uri-list', data: 'file:///tmp/example.txt', title: '', baseURL: '' }],
    files: ['/tmp/example.txt'],
    dragOperationsMask: 1,
  };
  const blocked = await new CdpDragDropController(blockedSession).transfer(
    { x: 1, y: 1 }, { x: 50, y: 50 }, { interceptTimeoutMs: 50 },
  );
  assert.equal(blocked.status, 'file-payload-blocked');
  assert.equal(JSON.stringify(blocked).includes('/tmp/example.txt'), false);
  assert.deepEqual(dragTypes(blockedSession), ['dragCancel']);

  const allowedSession = new FakeDragSession();
  allowedSession.dragData = blockedSession.dragData;
  const allowed = await new CdpDragDropController(allowedSession).transfer(
    { x: 1, y: 1 }, { x: 50, y: 50 }, { allowFiles: true, interceptTimeoutMs: 50 },
  );
  assert.equal(allowed.status, 'drop-dispatched');
  assert.equal(allowed.fileCount, 1);
  assert.deepEqual(dragTypes(allowedSession), ['dragEnter', 'dragOver', 'drop']);
});

test('missing native drag interception fails boundedly and releases pointer state', async () => {
  const session = new FakeDragSession();
  session.emitted = true;
  const result = await new CdpDragDropController(session).transfer(
    { x: 1, y: 1 }, { x: 50, y: 50 }, { interceptTimeoutMs: 1, dragStartSteps: 1 },
  );
  assert.equal(result.status, 'drag-not-started');
  assert.equal(session.pressed, false);
  assert.deepEqual(dragTypes(session), []);
});

test('invalid coordinates fail before touching CDP', async () => {
  const session = new FakeDragSession();
  const result = await new CdpDragDropController(session).transfer(
    { x: Number.NaN, y: 0 }, { x: 50, y: 50 },
  );
  assert.equal(result.status, 'invalid-point');
  assert.deepEqual(session.calls, []);
});
