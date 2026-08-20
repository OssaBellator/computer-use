import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CdpGameRegionLease,
  type GameRegionLocatorLike,
} from '../src/browser/gameRegionLease.js';
import type { CdpSessionLike } from '../src/browser/cdpIdentity.js';
import type { GameRegionCandidate } from '../src/browser/gameRegionLocator.js';

function box(x: number, y: number, width: number, height: number) {
  return {
    model: {
      border: [x, y, x + width, y, x + width, y + height, x, y + height],
    },
  };
}

function region(
  backendNodeId: number,
  x = 0,
  y = 0,
  width = 320,
  height = 180,
): GameRegionCandidate {
  return {
    kind: 'canvas',
    backendNodeId,
    rect: { x, y, width, height },
    clip: { x, y, width, height },
    visibleFraction: 1,
    viewportCoverage: width * height / (800 * 600),
    score: width * height * 1.25,
  };
}

test('game region lease refreshes geometry in place without a second locator search', async () => {
  let locateCalls = 0;
  const candidate = region(10);
  const locator: GameRegionLocatorLike = {
    async locate() {
      locateCalls += 1;
      return {
        viewportRect: { x: 0, y: 0, width: 800, height: 600 },
        primary: candidate,
        candidates: [candidate],
      };
    },
  };
  let resized = false;
  const session: CdpSessionLike = {
    async send(method) {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      }
      if (method === 'DOM.getBoxModel') {
        return resized ? box(0, 0, 480, 270) : box(0, 0, 320, 180);
      }
      throw new Error(`unexpected CDP method: ${method}`);
    },
  };

  const lease = new CdpGameRegionLease(session, locator);
  const acquired = await lease.acquire();
  assert.equal(acquired.status, 'acquired');
  assert.equal(acquired.generation, 1);

  resized = true;
  const refreshed = await lease.refresh();
  assert.equal(refreshed.status, 'refreshed');
  assert.equal(refreshed.generation, 1);
  assert.equal(refreshed.geometryChanged, true);
  assert.deepEqual(refreshed.region?.clip, { x: 0, y: 0, width: 480, height: 270 });
  assert.equal(refreshed.region?.backendNodeId, 10);
  assert.equal(locateCalls, 1);
});

test('game region lease reacquires and increments generation when renderer identity disappears', async () => {
  let locateCalls = 0;
  let candidate = region(10);
  const locator: GameRegionLocatorLike = {
    async locate() {
      locateCalls += 1;
      return {
        viewportRect: { x: 0, y: 0, width: 800, height: 600 },
        primary: candidate,
        candidates: [candidate],
      };
    },
  };
  const session: CdpSessionLike = {
    async send(method) {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      }
      if (method === 'DOM.getBoxModel') throw new Error('detached');
      throw new Error(`unexpected CDP method: ${method}`);
    },
  };

  const lease = new CdpGameRegionLease(session, locator);
  await lease.acquire();
  candidate = region(20, 0, 0, 400, 220);

  const reacquired = await lease.refresh();
  assert.equal(reacquired.status, 'reacquired');
  assert.equal(reacquired.generation, 2);
  assert.equal(reacquired.geometryChanged, true);
  assert.equal(reacquired.region?.backendNodeId, 20);
  assert.equal(locateCalls, 2);
});

test('fallback reacquisition of the same renderer does not invent a geometry change', async () => {
  let locateCalls = 0;
  const candidate = region(40, 5, 6, 300, 170);
  const locator: GameRegionLocatorLike = {
    async locate() {
      locateCalls += 1;
      return {
        viewportRect: { x: 0, y: 0, width: 800, height: 600 },
        primary: candidate,
        candidates: [candidate],
      };
    },
  };
  const session: CdpSessionLike = {
    async send(method) {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      }
      if (method === 'DOM.getBoxModel') throw new Error('transient probe failure');
      throw new Error(`unexpected CDP method: ${method}`);
    },
  };

  const lease = new CdpGameRegionLease(session, locator);
  await lease.acquire();
  const reacquired = await lease.refresh();

  assert.equal(reacquired.status, 'reacquired');
  assert.equal(reacquired.generation, 1);
  assert.equal(reacquired.geometryChanged, false);
  assert.equal(reacquired.region?.backendNodeId, 40);
  assert.equal(locateCalls, 2);
});

test('game region lease reports stable refreshes and returns cloned current state', async () => {
  const candidate = region(30, 10, 20, 300, 160);
  const locator: GameRegionLocatorLike = {
    async locate() {
      return {
        viewportRect: { x: 0, y: 0, width: 800, height: 600 },
        primary: candidate,
        candidates: [candidate],
      };
    },
  };
  const session: CdpSessionLike = {
    async send(method) {
      if (method === 'Page.getLayoutMetrics') {
        return { cssVisualViewport: { clientWidth: 800, clientHeight: 600 } };
      }
      if (method === 'DOM.getBoxModel') return box(10, 20, 300, 160);
      throw new Error(`unexpected CDP method: ${method}`);
    },
  };

  const lease = new CdpGameRegionLease(session, locator);
  await lease.acquire();
  const refreshed = await lease.refresh();
  assert.equal(refreshed.status, 'refreshed');
  assert.equal(refreshed.geometryChanged, false);
  assert.equal(refreshed.generation, 1);

  const current = lease.current();
  assert.ok(current);
  current.clip.width = 1;
  assert.equal(lease.current()?.clip.width, 300);
});

test('game region lease remains generation zero when no likely renderer exists', async () => {
  const locator: GameRegionLocatorLike = {
    async locate() {
      return {
        viewportRect: { x: 0, y: 0, width: 800, height: 600 },
        candidates: [],
      };
    },
  };
  const session: CdpSessionLike = { async send() { return {}; } };
  const lease = new CdpGameRegionLease(session, locator);

  const acquired = await lease.acquire();
  const refreshed = await lease.refresh();
  assert.deepEqual(acquired, {
    status: 'missing',
    generation: 0,
    geometryChanged: false,
  });
  assert.deepEqual(refreshed, {
    status: 'missing',
    generation: 0,
    geometryChanged: false,
  });
});
