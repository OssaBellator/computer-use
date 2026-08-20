import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { TaskRuntime } from '../../dist/src/agent/taskRuntime.js';
import { CdpTargetSessionRouter } from '../../dist/src/browser/cdpSessionRouter.js';
import { MultiPageCdpAgent } from '../../dist/src/engine/multiPageCdpAgent.js';
import { MultiPageTaskEngine } from '../../dist/src/engine/multiPageTaskEngine.js';

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

class BrowserConnection {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();

  constructor(url) {
    this.#ws = new WebSocket(url);
    this.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        message.error
          ? pending[1](new Error(JSON.stringify(message.error)))
          : pending[0](message.result);
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) {
        listener(message.params, message.sessionId);
      }
    });
  }

  async ready() {
    if (this.#ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener('open', resolve, { once: true });
      this.#ws.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      this.#pending.set(id, [resolve, reject]);
      this.#ws.send(JSON.stringify({
        id, method, params, ...(sessionId ? { sessionId } : {}),
      }));
    });
  }

  on(event, listener) {
    let listeners = this.#listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  off(event, listener) { this.#listeners.get(event)?.delete(listener); }
  close() { this.#ws.close(); }
}

async function launch() {
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'task-page-switch-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const version = await waitJson(`http://127.0.0.1:${port}/json/version`);
  const connection = new BrowserConnection(version.webSocketDebuggerUrl);
  await connection.ready();
  return { connection, child, profile };
}

async function stop(child, profile) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

async function seedTarget(router, targetId, label) {
  const session = await router.attach(targetId);
  try {
    await session.send('Runtime.evaluate', {
      expression: `document.body.innerHTML = '<button aria-label="${label}">${label}</button>'`,
    });
  } finally {
    await router.detach(session);
  }
}

test('task runtime statically switches to the newest real Chromium page before semantic work', async (t) => {
  const { connection, child, profile } = await launch();
  const router = new CdpTargetSessionRouter(connection);
  const pages = new MultiPageCdpAgent(router, { coalesceSnapshots: false });
  t.after(async () => {
    await pages.shutdown().catch(() => {});
    connection.close();
    await stop(child, profile);
  });

  // Start discovery first so a subsequently created page has the highest local sequence.
  await pages.start();
  const created = await pages.targets.createPage('about:blank');
  assert.equal(created.status, 'created');
  assert.ok(created.targetId);
  await seedTarget(router, created.targetId, 'Popup Continue');

  const program = {
    version: 1,
    entry: 'switch-popup',
    steps: [
      {
        id: 'switch-popup', kind: 'switch-page', target: 'latest-page',
        next: 'assert-popup', onFailure: 'failed',
      },
      {
        id: 'assert-popup', kind: 'assert',
        condition: { kind: 'exists', target: { name: 'Popup Continue', role: 'button' } },
        next: 'done', onFailure: 'failed',
      },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };

  const result = await new TaskRuntime(new MultiPageTaskEngine(pages)).run(program);
  assert.equal(result.status, 'completed');
  assert.equal(pages.summary().activeTargetId, created.targetId);
  assert.deepEqual(result.trace.map((entry) => entry.outcome), [
    'page-switched', 'asserted', 'completed',
  ]);
  assert.equal(result.trace[0]?.targetId, created.targetId);
  assert.equal(JSON.stringify(result.trace).includes('Popup Continue'), false);
});
