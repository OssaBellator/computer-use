import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { TaskRuntime } from '../../dist/src/agent/taskRuntime.js';
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
  const profile = await mkdtemp(join(tmpdir(), 'task-navigation-smoke-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank#start',
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

test('task runtime verifies browser-level navigation in real Chromium', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => { client.close(); await stop(child, profile); });
  const navigator = new CdpNavigationController(client);
  const engine = {
    async refresh() { return []; },
    async browserState() { return captureCdpBrowserState(client); },
    async navigate(url, options) { return navigator.navigate(url, options); },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const destination = 'about:blank#task-destination';
  const result = await new TaskRuntime(engine).run({
    version: 1,
    entry: 'navigate',
    inputs: ['destination'],
    steps: [
      { id: 'navigate', kind: 'navigate', url: { input: 'destination' }, next: 'verify' },
      { id: 'verify', kind: 'assert', condition: { kind: 'browser', state: { url: { input: 'destination' }, readyState: 'complete' } }, next: 'done' },
      { id: 'done', kind: 'complete' },
    ],
  }, { destination });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['navigated', 'asserted', 'completed']);
  assert.equal((await captureCdpBrowserState(client)).url, destination);
  assert.equal(JSON.stringify(result.trace).includes(destination), false);
});
