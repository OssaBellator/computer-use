import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpGameRegionLocator } from '../../dist/src/browser/gameRegionLocator.js';
import { CdpVisualObserver } from '../../dist/src/browser/visualObserver.js';

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
  const profile = await mkdtemp(join(tmpdir(), 'game-region-locator-'));
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

test('game region locator chooses the dominant visible canvas and feeds a bounded visual capture', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `
      document.body.style.margin = '0';
      document.body.innerHTML = [
        '<canvas id="tiny" style="width:80px;height:80px"></canvas>',
        '<canvas id="game" style="display:block;width:480px;height:270px"></canvas>',
        '<canvas id="hidden" style="display:none;width:900px;height:900px"></canvas>'
      ].join('');
      const ctx = document.querySelector('#game').getContext('2d');
      ctx.fillRect(20, 20, 120, 80);
    `,
  });

  const located = await new CdpGameRegionLocator(client).locate();
  assert.equal(located.primary?.kind, 'canvas');
  assert.deepEqual(
    [located.primary?.clip.width, located.primary?.clip.height],
    [480, 270],
  );
  assert.equal(located.candidates.length, 1);

  const snapshot = await new CdpVisualObserver(client).capture({
    clip: located.primary.clip,
    maxBytes: 512 * 1024,
  });
  assert.equal(snapshot.width, 480);
  assert.equal(snapshot.height, 270);
  assert.ok(snapshot.byteLength > 0);
});
