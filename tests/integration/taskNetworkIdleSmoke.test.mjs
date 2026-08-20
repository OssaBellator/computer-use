import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { TaskRuntime } from '../../dist/src/agent/taskRuntime.js';
import { createPureCdpBrowserAgentEngine } from '../../dist/src/engine/pureCdpEngine.js';

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
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      this.#pending.set(id, [resolve, reject]);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(event, listener) {
    let listeners = this.#listeners.get(event);
    if (!listeners) { listeners = new Set(); this.#listeners.set(event, listeners); }
    listeners.add(listener);
  }
  off(event, listener) { this.#listeners.get(event)?.delete(listener); }
  close() { this.#ws.close(); }
}
async function launch() {
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'task-network-idle-'));
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

test('static task waits for real Chromium URL-redacted network idle', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => { client.close(); await stop(child, profile); });

  const engine = await createPureCdpBrowserAgentEngine(client, {
    coalesceSnapshots: false,
    networkActivity: true,
  });
  await engine.prepare();

  const sensitive = 'data:text/plain,task-network-secret';
  await client.send('Runtime.evaluate', {
    expression: `fetch(${JSON.stringify(sensitive)}).then(r => r.text())`,
    awaitPromise: true,
    returnByValue: true,
  });

  const program = {
    version: 1,
    entry: 'quiet',
    steps: [
      {
        id: 'quiet', kind: 'wait-network-idle', quietMs: 40, maxInflight: 0,
        timeoutMs: 1000, pollIntervalMs: 10, next: 'done', onTimeout: 'failed',
      },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };
  const result = await new TaskRuntime(engine).run(program);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['wait-satisfied', 'completed']);
  const summary = engine.networkActivity?.summary();
  assert.ok((summary?.started ?? 0) >= 1);
  assert.equal(summary?.inFlight, 0);
  assert.equal(JSON.stringify(summary).includes('task-network-secret'), false);
  assert.equal(JSON.stringify(result.trace).includes('task-network-secret'), false);
});
