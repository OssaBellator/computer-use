import test from 'node:test';
import assert from 'node:assert/strict';
import { CdpRuntimeSnapshotPage } from '../src/browser/cdpRuntimePage.js';
import type { CdpSessionLike } from '../src/browser/cdpIdentity.js';

class Session implements CdpSessionLike {
  frameTree: any = {
    frame: { id: 'main-id', url: 'about:blank', name: '' },
    childFrames: [
      { frame: { id: 'child-id', parentId: 'main-id', url: 'about:srcdoc', name: 'child' } },
    ],
  };
  nextContext = 100;
  readonly frameForContext = new Map<number, string>();
  readonly worldCalls: string[] = [];
  failNextEvaluation = false;

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    if (method === 'Page.getFrameTree') return { frameTree: this.frameTree };
    if (method === 'Page.createIsolatedWorld') {
      const frameId = params.frameId as string;
      this.worldCalls.push(frameId);
      const executionContextId = this.nextContext++;
      this.frameForContext.set(executionContextId, frameId);
      return { executionContextId };
    }
    if (method === 'Runtime.evaluate') {
      if (this.failNextEvaluation) {
        this.failNextEvaluation = false;
        throw new Error('Cannot find context with specified id');
      }
      const frameId = this.frameForContext.get(params.contextId as number);
      return { result: { value: frameId } };
    }
    throw new Error(`unexpected method: ${method}`);
  }
}

test('pure CDP snapshot page preserves frame order, metadata, and parent identity', async () => {
  const session = new Session();
  const page = new CdpRuntimeSnapshotPage(session);
  await page.refresh();

  const frames = page.frames();
  assert.equal(frames.length, 2);
  assert.equal(frames[0]?.url?.(), 'about:blank');
  assert.equal(frames[1]?.url?.(), 'about:srcdoc');
  assert.equal(frames[1]?.name?.(), 'child');
  assert.equal(frames[1]?.parentFrame?.(), frames[0]);
  assert.equal(await frames[0]!.evaluate(() => 'ignored'), 'main-id');
  assert.equal(await frames[1]!.evaluate(() => 'ignored'), 'child-id');
});

test('frame evaluation recreates an isolated world once after stale-context protocol failure', async () => {
  const session = new Session();
  const page = new CdpRuntimeSnapshotPage(session);
  await page.refresh();
  const main = page.frames()[0]!;

  assert.equal(await main.evaluate(() => 'first'), 'main-id');
  session.failNextEvaluation = true;
  assert.equal(await main.evaluate(() => 'second'), 'main-id');
  assert.equal(session.worldCalls.filter((id) => id === 'main-id').length, 2);
});

test('frame-tree refresh drops detached frames and invalidates worlds after navigation', async () => {
  const session = new Session();
  const page = new CdpRuntimeSnapshotPage(session);
  await page.refresh();
  const main = page.frames()[0]!;
  await main.evaluate(() => 'first');

  session.frameTree = { frame: { id: 'main-id', url: 'about:blank#next', name: '' } };
  await page.refresh();
  assert.equal(page.frames().length, 1);
  assert.equal(page.frameById('child-id'), undefined);
  assert.equal(await page.frames()[0]!.evaluate(() => 'second'), 'main-id');
  assert.equal(session.worldCalls.filter((id) => id === 'main-id').length, 2);
});
