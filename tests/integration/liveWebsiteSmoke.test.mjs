import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpNavigationController } from '../../dist/src/browser/navigationController.js';
import { captureCdpBrowserState } from '../../dist/src/browser/browserState.js';

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
    try { const response = await fetch(url); if (response.ok) return response.json(); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
class Client {
  #ws; #id = 0; #pending = new Map();
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
  close() { this.#ws.close(); }
}
async function launch() {
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'live-web-smoke-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  const pages = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const target = pages.find((page) => page.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('No Chromium page target');
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

const liveEnabled = process.env.RUN_LIVE_WEB === '1';

test('live Chromium navigation reaches example.com and captures browser state', {
  skip: liveEnabled ? false : 'set RUN_LIVE_WEB=1 to run network-dependent browser coverage',
}, async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => { client.close(); await stop(child, profile); });
  const result = await new CdpNavigationController(client).navigate('https://example.com/', {
    timeoutMs: 15_000,
    maxPolls: 300,
    pollIntervalMs: 50,
  });
  assert.equal(result.status, 'navigated');
  const state = await captureCdpBrowserState(client);
  assert.equal(new URL(state.url).hostname, 'example.com');
  assert.match(state.title, /Example/i);
  assert.equal(state.readyState, 'complete');
});
