import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpNetworkActivityMonitor } from '../../dist/src/browser/networkActivityMonitor.js';

async function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
async function waitJson(url) { for (let i = 0; i < 100; i += 1) { try { const response = await fetch(url); if (response.ok) return response.json(); } catch {} await new Promise((resolve) => setTimeout(resolve, 40)); } throw new Error(`Timed out waiting for ${url}`); }
class Client {
  #ws; #id = 0; #pending = new Map(); #listeners = new Map();
  constructor(url) {
    this.#ws = new WebSocket(url);
    this.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) { const pending = this.#pending.get(message.id); if (!pending) return; this.#pending.delete(message.id); message.error ? pending[1](new Error(JSON.stringify(message.error))) : pending[0](message.result); return; }
      for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
    });
  }
  async ready() { if (this.#ws.readyState === WebSocket.OPEN) return; await new Promise((resolve, reject) => { this.#ws.addEventListener('open', resolve, { once: true }); this.#ws.addEventListener('error', reject, { once: true }); }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.#id; this.#pending.set(id, [resolve, reject]); this.#ws.send(JSON.stringify({ id, method, params })); }); }
  on(event, listener) { let listeners = this.#listeners.get(event); if (!listeners) { listeners = new Set(); this.#listeners.set(event, listeners); } listeners.add(listener); }
  off(event, listener) { this.#listeners.get(event)?.delete(listener); }
  close() { this.#ws.close(); }
}
async function launch() {
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'network-activity-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  const pages = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const target = pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl);
  if (!target) throw new Error('No Chromium page target');
  const client = new Client(target.webSocketDebuggerUrl); await client.ready(); return { client, child, profile };
}
async function stop(child, profile) { if (child.exitCode === null && child.signalCode === null) { const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGKILL'); await exited; } await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); }

test('real Chromium network monitor observes a request then reaches URL-redacted idle', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => { client.close(); await stop(child, profile); });
  const monitor = new CdpNetworkActivityMonitor(client);
  await monitor.start();
  const sensitive = 'data:text/plain,frontier-secret-payload';
  await client.send('Runtime.evaluate', { expression: `fetch(${JSON.stringify(sensitive)}).then(r => r.text())`, awaitPromise: true, returnByValue: true });
  const idle = await monitor.waitForIdle({ quietMs: 40, timeoutMs: 1000, pollIntervalMs: 10 });
  assert.equal(idle.idle, true);
  assert.ok(idle.summary.started >= 1);
  assert.equal(idle.summary.inFlight, 0);
  assert.equal(JSON.stringify(idle.summary).includes('frontier-secret-payload'), false);
});
