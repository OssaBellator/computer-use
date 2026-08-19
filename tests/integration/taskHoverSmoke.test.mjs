import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { TaskRuntime } from '../../dist/src/agent/taskRuntime.js';
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
  const profile = await mkdtemp(join(tmpdir(), 'task-hover-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
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

test('static hover task verifies a real Chromium mouseenter semantic reveal', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => { client.close(); await stop(child, profile); });

  await client.send('Runtime.evaluate', {
    expression: `(() => {
      document.body.innerHTML = '<button id="trigger" aria-label="More options" style="position:absolute;left:220px;top:120px;width:140px;height:48px">More</button>';
      document.querySelector('#trigger').addEventListener('mouseenter', () => {
        if (document.querySelector('#revealed')) return;
        const revealed = document.createElement('button');
        revealed.id = 'revealed';
        revealed.setAttribute('aria-label', 'Hover revealed action');
        revealed.textContent = 'Revealed';
        revealed.style.cssText = 'position:absolute;left:380px;top:120px;width:160px;height:48px';
        document.body.appendChild(revealed);
      });
    })()`,
  });

  const engine = await createPureCdpInteractionEngine(client, {
    coalesceSnapshots: false,
    pointerOptions: { sleep: async () => {}, sampleIntervalMs: 100 },
  });
  const program = {
    version: 1,
    entry: 'hover',
    steps: [
      {
        id: 'hover', kind: 'hover', target: { role: 'button', name: 'More options' },
        next: 'check', onFailure: 'failed', timeoutMs: 500, maxSamples: 20,
        pollIntervalMs: 5,
      },
      {
        id: 'check', kind: 'assert',
        condition: { kind: 'exists', target: { role: 'button', name: 'Hover revealed action' } },
        next: 'done', onFailure: 'failed',
      },
      { id: 'done', kind: 'complete' },
      { id: 'failed', kind: 'fail' },
    ],
  };

  const result = await new TaskRuntime(engine).run(program);
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), ['verified', 'asserted', 'completed']);
  assert.equal(JSON.stringify(result.trace).includes('More options'), false);
  assert.equal(JSON.stringify(result.trace).includes('Hover revealed action'), false);

  const present = await client.send('Runtime.evaluate', {
    expression: `Boolean(document.querySelector('#revealed'))`, returnByValue: true,
  });
  assert.equal(present.result.value, true);
});
