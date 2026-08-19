import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { createCdpInteractionEngine } from '../../dist/src/engine/cdpInteractionEngine.js';

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
  close() { this.#ws.close(); }
}

async function launch() {
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'scroll-reveal-smoke-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
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

function pageFor(client) {
  const frame = {
    async evaluate(pageFunction) {
      const result = await client.send('Runtime.evaluate', {
        expression: `(${pageFunction.toString()})()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
      return result.result.value;
    },
    url() { return 'about:blank'; },
    name() { return ''; },
    parentFrame() { return null; },
  };
  return { frames: () => [frame] };
}

async function value(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  return result.result.value;
}

test('engine reveals and acquires a target below the fold using wheel input', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `document.body.innerHTML='<div style="height:1700px"></div><button id="below" style="margin-left:250px;width:140px;height:44px">Below fold</button><div style="height:600px"></div>'`,
  });

  const engine = createCdpInteractionEngine(pageFor(client), client, {
    touchpadOptions: { initialCursor: { x: 10, y: 10 } },
    pointerOptions: { sleep: async () => {}, sampleIntervalMs: 100 },
  });
  const result = await engine.acquire(
    { name: 'Below fold', role: 'button' },
    {
      includeDirectional: false,
      revealOptions: {
        timeoutMs: 300,
        pollIntervalMs: 10,
        maxSamples: 10,
      },
    },
  );

  assert.equal(result.status, 'reached');
  assert.equal(result.reveal?.status, 'revealed');
  assert.ok((await value(client, 'window.scrollY')) > 0);
  assert.equal(result.target?.mainViewportVisible, true);
  assert.equal(await engine.observer.pointStillTargets(result.target, engine.touchpad.cursor), true);
});
