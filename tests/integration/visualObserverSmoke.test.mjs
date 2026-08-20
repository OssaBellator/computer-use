import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
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
  const profile = await mkdtemp(join(tmpdir(), 'visual-observer-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', '--window-size=640,480',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
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

test('real Chromium visual fingerprint changes after paint-only state changes', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => { client.close(); await stop(child, profile); });
  await client.send('Runtime.evaluate', {
    expression: `document.body.style.margin='0'; document.body.innerHTML='<canvas id="c" width="320" height="200"></canvas>'; const ctx=c.getContext('2d'); ctx.fillStyle='rgb(20,40,60)'; ctx.fillRect(0,0,320,200);`,
  });
  const observer = new CdpVisualObserver(client);
  const first = await observer.capture({ maxBytes: 2 * 1024 * 1024 });
  assert.equal(first.mimeType, 'image/png');
  assert.ok(first.byteLength > 100);
  assert.ok((first.width ?? 0) > 0);
  assert.ok((first.height ?? 0) > 0);

  await client.send('Runtime.evaluate', {
    expression: `const ctx=c.getContext('2d'); ctx.fillStyle='rgb(220,40,60)'; ctx.fillRect(0,0,320,200);`,
  });
  const changed = await observer.waitForChange(first.sha256, {
    maxSamples: 5,
    pollIntervalMs: 10,
    timeoutMs: 500,
    maxBytes: 2 * 1024 * 1024,
  });
  assert.equal(changed.changed, true);
  assert.notEqual(changed.snapshot.sha256, first.sha256);
});
