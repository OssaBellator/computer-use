import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpInputAdapter } from '../../dist/src/input/cdpInputAdapter.js';
import { CdpPointerLockObserver } from '../../dist/src/browser/cdpPointerLockObserver.js';
import { PointerLockController } from '../../dist/src/controller/pointerLockController.js';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
  });
}

async function waitJson(url) {
  for (let index = 0; index < 100; index += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class Client {
  #ws;
  #id = 0;
  #pending = new Map();

  constructor(url) {
    this.#ws = new WebSocket(url);
    this.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      message.error
        ? pending[1](new Error(JSON.stringify(message.error)))
        : pending[0](message.result);
    });
  }

  async ready() {
    if (this.#ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener('open', resolve, { once: true });
      this.#ws.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      this.#pending.set(id, [resolve, reject]);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { this.#ws.close(); }
}

async function launch() {
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'pointer-lock-lifecycle-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new',
    '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const pages = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const target = pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl);
  if (!target) throw new Error('No Chromium page target');
  const client = new Client(target.webSocketDebuggerUrl);
  await client.ready();
  return { client, child, profile, targetId: target.id };
}

async function stop(child, profile) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

async function fixtureState(client) {
  const result = await client.send('Runtime.evaluate', {
    expression: 'window.__pointerFixture',
    returnByValue: true,
  });
  return result.result.value;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('synthetic Chromium observes pointer capture and either real pointer lock or explicit rejection', async (t) => {
  const { client, child, profile, targetId } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `
      document.body.style.margin = '0';
      document.body.innerHTML = '<canvas id="game" width="320" height="180" tabindex="0"></canvas>';
      const game = document.getElementById('game');
      window.__pointerFixture = {
        pointerId: null,
        captureGained: 0,
        captureLost: 0,
        lockChanges: 0,
        lockErrors: 0,
        enableLockRequest: false,
        moves: [],
      };
      game.addEventListener('pointerdown', (event) => {
        window.__pointerFixture.pointerId = event.pointerId;
        game.setPointerCapture(event.pointerId);
      });
      game.addEventListener('gotpointercapture', () => window.__pointerFixture.captureGained++);
      game.addEventListener('lostpointercapture', () => window.__pointerFixture.captureLost++);
      document.addEventListener('pointerlockchange', () => window.__pointerFixture.lockChanges++);
      document.addEventListener('pointerlockerror', () => window.__pointerFixture.lockErrors++);
      document.addEventListener('mousemove', (event) => {
        window.__pointerFixture.moves.push([event.movementX, event.movementY]);
      });
      game.addEventListener('click', () => {
        if (!window.__pointerFixture.enableLockRequest) return;
        try {
          const result = game.requestPointerLock();
          if (result?.catch) result.catch(() => {});
        } catch {}
      });
    `,
  });

  const object = await client.send('Runtime.evaluate', {
    expression: 'document.getElementById("game")',
  });
  const described = await client.send('DOM.describeNode', { objectId: object.result.objectId });
  const backendNodeId = described.node.backendNodeId;
  await client.send('Runtime.releaseObject', { objectId: object.result.objectId });
  const frameTree = await client.send('Page.getFrameTree');
  const frameId = frameTree.frameTree.frame.id;

  const input = new CdpInputAdapter(client);
  const observer = new CdpPointerLockObserver(client, {
    targetId,
    frameId,
    gameRegion: () => ({ backendNodeId, generation: 1 }),
  });

  await input.movePointer({ x: 100, y: 90 });
  await input.pointerDown('left');
  await sleep(20);
  const pressed = await fixtureState(client);
  assert.equal(Number.isInteger(pressed.pointerId), true);
  const captured = await observer.observeCapture(pressed.pointerId, backendNodeId);
  assert.equal(captured.supported, true);
  assert.equal(captured.captured, true);
  assert.equal(captured.owner.backendNodeId, backendNodeId);

  await input.pointerUp('left');
  await sleep(20);
  const released = await observer.observeCapture(pressed.pointerId, backendNodeId);
  assert.equal(released.captured, false);
  assert.ok((await fixtureState(client)).captureLost >= 1);

  await client.send('Runtime.evaluate', {
    expression: 'window.__pointerFixture.enableLockRequest = true',
  });
  const controller = new PointerLockController(input, observer, { sleep });
  const acquired = await controller.acquire({
    owner: {
      targetId,
      frameId,
      backendNodeId,
      gameRegionBackendNodeId: backendNodeId,
      gameRegionGeneration: 1,
    },
    request: async () => {
      await input.movePointer({ x: 100, y: 90 });
      await input.pointerDown('left');
      await input.pointerUp('left');
    },
    maxAttempts: 1,
    pollsPerAttempt: 8,
    pollIntervalMs: 20,
  });

  const browserState = await fixtureState(client);
  if (acquired.status === 'locked') {
    await controller.moveRelative({ x: 7, y: -3 }, {
      requirement: 'required',
      owner: { backendNodeId },
    });
    await sleep(20);
    assert.ok((await fixtureState(client)).moves.some(([x, y]) => x === 7 && y === -3));

    await input.pressKey('Escape');
    await sleep(30);
    const afterEscape = await controller.observe('escape');
    if (afterEscape.phase === 'locked') {
      await client.send('Runtime.evaluate', { expression: 'document.exitPointerLock()' });
      await sleep(20);
      assert.equal((await controller.observe()).phase, 'lost');
    } else {
      assert.equal(afterEscape.phase, 'lost');
      assert.equal(afterEscape.lossReason, 'escape');
    }
  } else if (acquired.status === 'unsupported') {
    assert.equal((await observer.observeLock()).supported, false);
  } else {
    assert.ok(['timed-out', 'request-rejected'].includes(acquired.status));
    assert.ok(
      browserState.lockErrors > 0,
      `expected explicit pointerlockerror, got ${JSON.stringify(browserState)}`,
    );
    assert.notEqual(controller.current().phase, 'locked');
  }
});
