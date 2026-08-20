import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpInputAdapter } from '../../dist/src/input/cdpInputAdapter.js';
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
  const profile = await mkdtemp(join(tmpdir(), 'relative-game-input-'));
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

async function state(client) {
  const result = await client.send('Runtime.evaluate', {
    expression: 'window.__game',
    returnByValue: true,
  });
  return result.result.value;
}

test('relative realtime input produces movementX/movementY while a keyboard control stays held', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `
      document.body.innerHTML = '<canvas id="game" width="320" height="180"></canvas>';
      document.body.style.margin = '0';
      window.__game = { yaw: 0, pitch: 0, forward: false, keydowns: 0, keyups: 0, moves: [] };
      addEventListener('mousemove', (event) => {
        window.__game.yaw += event.movementX;
        window.__game.pitch += event.movementY;
        window.__game.moves.push([event.movementX, event.movementY]);
      });
      addEventListener('keydown', (event) => {
        if (event.key !== 'w' || event.repeat) return;
        window.__game.forward = true;
        window.__game.keydowns += 1;
      });
      addEventListener('keyup', (event) => {
        if (event.key !== 'w') return;
        window.__game.forward = false;
        window.__game.keyups += 1;
      });
    `,
  });

  const input = new CdpInputAdapter(client);
  await input.movePointer({ x: 100, y: 90 });
  await client.send('Runtime.evaluate', {
    expression: 'window.__game.yaw=0;window.__game.pitch=0;window.__game.moves=[]',
  });

  const result = await new RealtimeControlLoop(input, {
    observe: () => state(client),
    decide: ({ observation }) => observation.yaw >= 18
      ? { stop: true, reason: 'look-target' }
      : { heldKeys: ['w'], pointerDelta: { x: 6, y: -2 } },
    tickIntervalMs: 8,
    maxTicks: 20,
    maxDurationMs: 1_000,
  }).run();

  const finalState = await state(client);
  assert.equal(result.status, 'stopped');
  assert.equal(result.reason, 'look-target');
  assert.equal(finalState.yaw, 18);
  assert.equal(finalState.pitch, -6);
  assert.deepEqual(finalState.moves, [[6, -2], [6, -2], [6, -2]]);
  assert.equal(finalState.forward, false);
  assert.equal(finalState.keydowns, 1);
  assert.equal(finalState.keyups, 1);
});
