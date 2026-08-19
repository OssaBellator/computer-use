import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createPureCdpInteractionEngine } from '../../dist/src/engine/pureCdpEngine.js';
import { CdpVisualObserver } from '../../dist/src/browser/visualObserver.js';
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
  const profile = await mkdtemp(join(tmpdir(), 'realtime-game-loop-'));
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

test('realtime loop holds a real browser key across animated canvas frames and releases it on stop', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `
      document.body.innerHTML = '<canvas id="game" width="320" height="120"></canvas>';
      document.body.style.margin = '0';
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
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.fillRect(window.__game.x, 45, 18, 18);
      }
      draw();
      window.__gameTimer = setInterval(() => {
        if (window.__game.right) window.__game.x += 2;
        draw();
      }, 8);
    `,
  });

  const engine = await createPureCdpInteractionEngine(client, { coalesceSnapshots: false });
  const visual = new CdpVisualObserver(client);
  const initialImage = await visual.capture({ clip: { x: 0, y: 0, width: 320, height: 120 } });

  const result = await new RealtimeControlLoop(engine.input, {
    observe: () => gameState(client),
    decide: ({ observation }) => observation.x >= 30
      ? { stop: true, reason: 'target-x' }
      : { heldKeys: ['ArrowRight'] },
    tickIntervalMs: 20,
    maxTicks: 80,
    maxDurationMs: 2_000,
  }).run();

  const finalState = await gameState(client);
  const finalImage = await visual.capture({ clip: { x: 0, y: 0, width: 320, height: 120 } });
  await client.send('Runtime.evaluate', { expression: 'clearInterval(window.__gameTimer)' });

  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'target-x');
  assert.ok(result.ticks > 1);
  assert.ok(finalState.x >= 30);
  assert.equal(finalState.right, false);
  assert.equal(finalState.keydowns, 1);
  assert.equal(finalState.keyups, 1);
  assert.notEqual(finalImage.sha256, initialImage.sha256);
});
