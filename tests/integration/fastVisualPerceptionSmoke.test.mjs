import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createPureCdpInteractionEngine } from '../../dist/src/engine/pureCdpEngine.js';
import { CdpVisualObserver } from '../../dist/src/browser/visualObserver.js';
import { VisualMotionSampler } from '../../dist/src/browser/visualDiff.js';
import { RealtimeControlLoop } from '../../dist/src/agent/realtimeControlLoop.js';

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
  for (let i = 0; i < 100; i += 1) {
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
  counts = new Map();

  constructor(url) {
    this.#ws = new WebSocket(url);
    this.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      message.error ? pending[1](new Error(JSON.stringify(message.error))) : pending[0](message.result);
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
    this.counts.set(method, (this.counts.get(method) ?? 0) + 1);
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      this.#pending.set(id, [resolve, reject]);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.#ws.close();
  }
}

async function launch() {
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'fast-visual-perception-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  const pages = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const target = pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl);
  if (!target) throw new Error('No Chromium page target');
  const client = new Client(target.webSocketDebuggerUrl);
  await client.ready();
  return { client, child, profile };
}

async function stop(child, profile) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

async function gameState(client) {
  const result = await client.send('Runtime.evaluate', {
    expression: `({ x: window.__game.x, right: window.__game.right, keydowns: window.__game.keydowns, keyups: window.__game.keyups })`,
    returnByValue: true,
  });
  return result.result.value;
}

test('control ticks outrun downscaled canvas observations while motion regions still drive stop', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `
      document.body.style.margin = '0';
      document.body.innerHTML = '<canvas id="game" width="240" height="100"></canvas>';
      const canvas = document.getElementById('game');
      const ctx = canvas.getContext('2d');
      window.__game = { x: 10, right: false, keydowns: 0, keyups: 0 };
      addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight' || event.repeat) return;
        window.__game.right = true;
        window.__game.keydowns += 1;
      });
      addEventListener('keyup', (event) => {
        if (event.key !== 'ArrowRight') return;
        window.__game.right = false;
        window.__game.keyups += 1;
      });
      function draw() {
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'black';
        ctx.fillRect(window.__game.x, 40, 16, 16);
      }
      draw();
      window.__gameTimer = setInterval(() => {
        if (window.__game.right) window.__game.x += 4;
        draw();
      }, 5);
    `,
  });

  const engine = await createPureCdpInteractionEngine(client, { coalesceSnapshots: false });
  const sampler = new VisualMotionSampler(new CdpVisualObserver(client), {
    capture: {
      clip: { x: 0, y: 0, width: 240, height: 100 },
      scale: 0.5,
      maxBytes: 500_000,
    },
    tileSizePx: 8,
    pixelStride: 1,
    pixelDeltaThreshold: 20,
    tileChangedFraction: 0.05,
  });

  const seen = [];
  const result = await new RealtimeControlLoop(engine.input, {
    observe: () => sampler.sample(),
    decide: ({ observation, observationFresh, observationAgeTicks }) => {
      seen.push({ sequence: observation.sequence, fresh: observationFresh, ageTicks: observationAgeTicks });
      const bounds = observation.difference?.viewportMotionBounds;
      if (observationFresh && observation.difference?.changed && bounds && bounds.x + bounds.width >= 50) {
        return { stop: true, reason: 'visual-motion-target' };
      }
      return { heldKeys: ['ArrowRight'] };
    },
    tickIntervalMs: 10,
    observeEveryTicks: 4,
    maxTicks: 40,
    maxDurationMs: 2_000,
  }).run();

  const finalState = await gameState(client);
  await client.send('Runtime.evaluate', { expression: 'clearInterval(window.__gameTimer)' });
  const screenshotCount = client.counts.get('Page.captureScreenshot') ?? 0;

  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'visual-motion-target');
  assert.ok(result.ticks >= 5);
  assert.ok(finalState.x >= 30);
  assert.equal(finalState.right, false);
  assert.equal(finalState.keydowns, 1);
  assert.equal(finalState.keyups, 1);
  assert.ok(screenshotCount >= 2);
  assert.ok(screenshotCount < result.ticks);
  assert.ok(seen.some((sample) => !sample.fresh && sample.ageTicks > 0));
  assert.ok(seen.some((sample) => sample.fresh && sample.sequence >= 2));
});
