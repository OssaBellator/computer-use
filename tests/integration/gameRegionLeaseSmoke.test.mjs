import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpGameRegionLease } from '../../dist/src/browser/gameRegionLease.js';

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
  const profile = await mkdtemp(join(tmpdir(), 'game-region-lease-'));
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

test('game region lease refreshes resize in place and reacquires after renderer replacement', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `
      document.body.style.margin = '0';
      document.body.innerHTML = '<canvas id="game" style="display:block;width:320px;height:180px"></canvas>';
    `,
  });

  const lease = new CdpGameRegionLease(client);
  const acquired = await lease.acquire();
  assert.equal(acquired.status, 'acquired');
  assert.equal(acquired.generation, 1);
  assert.deepEqual(
    [acquired.region?.clip.width, acquired.region?.clip.height],
    [320, 180],
  );
  const firstBackendNodeId = acquired.region?.backendNodeId;
  assert.equal(typeof firstBackendNodeId, 'number');

  await client.send('Runtime.evaluate', {
    expression: `
      document.querySelector('#game').style.width = '480px';
      document.querySelector('#game').style.height = '270px';
    `,
  });
  const resized = await lease.refresh();
  assert.equal(resized.status, 'refreshed');
  assert.equal(resized.generation, 1);
  assert.equal(resized.geometryChanged, true);
  assert.equal(resized.region?.backendNodeId, firstBackendNodeId);
  assert.deepEqual(
    [resized.region?.clip.width, resized.region?.clip.height],
    [480, 270],
  );

  await client.send('Runtime.evaluate', {
    expression: `
      document.querySelector('#game').outerHTML = '<canvas id="game" style="display:block;width:400px;height:220px"></canvas>';
    `,
  });
  const replaced = await lease.refresh();
  assert.equal(replaced.status, 'reacquired');
  assert.equal(replaced.generation, 2);
  assert.equal(replaced.geometryChanged, true);
  assert.notEqual(replaced.region?.backendNodeId, firstBackendNodeId);
  assert.deepEqual(
    [replaced.region?.clip.width, replaced.region?.clip.height],
    [400, 220],
  );
});
