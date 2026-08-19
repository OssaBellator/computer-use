import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createPureCdpInteractionEngine } from '../../dist/src/engine/pureCdpEngine.js';

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

  close() {
    this.#ws.close();
  }
}

async function launch() {
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'roving-composite-'));
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

test('roving tablist metadata constrains Arrow planning to the owning composite in Chromium', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `
      document.body.innerHTML = \`
        <style>
          body { margin: 0; position: relative; width: 600px; height: 200px; }
          #outside { position: absolute; left: 45px; top: 20px; }
          #tabs { position: absolute; left: 10px; top: 80px; display: flex; gap: 140px; }
        </style>
        <button id="outside">Outside</button>
        <div id="tabs" role="tablist" aria-label="Workspace tabs">
          <button id="first" role="tab" tabindex="0">First</button>
          <button id="second" role="tab" tabindex="-1">Second</button>
        </div>
      \`;
      const first = document.getElementById('first');
      const second = document.getElementById('second');
      document.getElementById('tabs').addEventListener('keydown', (event) => {
        if (event.key !== 'ArrowRight') return;
        event.preventDefault();
        first.tabIndex = -1;
        second.tabIndex = 0;
        second.focus();
      });
      first.focus();
    `,
  });

  const engine = await createPureCdpInteractionEngine(client, { coalesceSnapshots: false });
  const before = await engine.refresh();
  const first = before.find((node) => node.role === 'tab' && node.name === 'First');
  const second = before.find((node) => node.role === 'tab' && node.name === 'Second');
  assert.ok(first);
  assert.ok(second);
  assert.equal(first.tabIndex, 0);
  assert.equal(second.tabIndex, -1);
  assert.ok(first.compositeOwnerStructuralId);
  assert.equal(first.compositeOwnerStructuralId, second.compositeOwnerStructuralId);

  const result = await engine.acquire(
    { role: 'tab', name: 'Second' },
    { includePointer: false, maxReplans: 0, maxExecutedEdges: 2 },
  );
  assert.equal(result.status, 'reached');
  assert.ok(result.execution);
  assert.equal(result.execution.replans, 0);
  assert.equal(result.execution.executed.length, 1);
  assert.equal(result.execution.executed[0].edge.kind, 'spatial-right');
  assert.equal(result.execution.executed[0].edge.to, second.id);
  assert.equal(result.execution.executed[0].result.succeeded, true);

  const active = await client.send('Runtime.evaluate', {
    expression: `document.activeElement && document.activeElement.id`,
    returnByValue: true,
  });
  assert.equal(active.result.value, 'second');
});
