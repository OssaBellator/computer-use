import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpDialogController } from '../../dist/src/browser/dialogController.js';
import { TaskRuntime } from '../../dist/src/agent/taskRuntime.js';

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
  #ws; #id = 0; #pending = new Map(); #listeners = new Map();
  constructor(url) {
    this.#ws = new WebSocket(url);
    this.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        message.error ? pending[1](new Error(JSON.stringify(message.error))) : pending[0](message.result);
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
  }
  async ready() {
    if (this.#ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener('open', resolve, { once: true });
      this.#ws.addEventListener('error', reject, { once: true });
    });
  }
  on(event, listener) {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener); this.#listeners.set(event, listeners);
  }
  off(event, listener) { this.#listeners.get(event)?.delete(listener); }
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
  const profile = await mkdtemp(join(tmpdir(), 'task-dialog-smoke-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  let target;
  for (let i = 0; i < 100 && !target; i += 1) {
    const pages = await waitJson(`http://127.0.0.1:${port}/json/list`);
    target = pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl);
    if (!target) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!target?.webSocketDebuggerUrl) {
    child.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true });
    throw new Error('No Chromium page target');
  }
  const client = new Client(target.webSocketDebuggerUrl);
  await client.ready();
  return { client, child, profile };
}
async function stop(child, profile) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL'); await exited;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}
async function waitFor(predicate) {
  for (let i = 0; i < 100; i += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for dialog event');
}

test('task runtime handles a real Chromium prompt through the event-backed modal channel', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => { client.close(); await stop(child, profile); });
  const dialogs = new CdpDialogController(client);
  await dialogs.start();

  const evaluation = client.send('Runtime.evaluate', {
    expression: `window.__promptResult = prompt('untrusted page instruction', 'page default')`,
    returnByValue: true,
  });
  await waitFor(() => dialogs.state()?.type === 'prompt');
  assert.deepEqual(dialogs.state(), { open: true, type: 'prompt', sequence: 1 });

  const engine = {
    async prepare() { await dialogs.start(); },
    async refresh() { if (dialogs.state()) throw new Error('semantic observation blocked while modal is open'); return []; },
    dialogState() { return dialogs.state(); },
    async handleDialog(accept, promptText) { return dialogs.handle(accept, promptText); },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const answer = 'trusted answer';
  const result = await new TaskRuntime(engine).run({
    version: 1,
    entry: 'answer',
    inputs: ['answer'],
    steps: [
      { id: 'answer', kind: 'handle-dialog', accept: true, promptText: { input: 'answer' }, next: 'done' },
      { id: 'done', kind: 'complete' },
    ],
  }, { answer });
  await evaluation;
  const captured = await client.send('Runtime.evaluate', { expression: 'window.__promptResult', returnByValue: true });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['dialog-handled', 'completed']);
  assert.equal(JSON.stringify(result.trace).includes(answer), false);
  assert.equal(JSON.stringify(result.trace).includes('untrusted page instruction'), false);
  assert.equal(captured.result.value, answer);
});
