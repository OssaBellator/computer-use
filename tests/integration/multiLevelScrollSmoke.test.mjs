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
  const profile = await mkdtemp(join(tmpdir(), 'multi-scroll-smoke-'));
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
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  return result.result.value;
}

test('engine reveals a target through two nested overflow scopes outside-in', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `document.body.innerHTML = \`
      <div id="outer" aria-label="Outer" style="position:absolute;left:100px;top:60px;width:300px;height:160px;overflow:auto;border:2px solid black">
        <div style="height:720px;padding-top:340px;box-sizing:border-box">
          <div id="inner" aria-label="Inner" style="width:230px;height:120px;overflow:auto;border:2px solid blue">
            <div style="height:430px;padding-top:270px;box-sizing:border-box">
              <button id="deep" style="width:140px;height:40px">Deep target</button>
            </div>
          </div>
        </div>
      </div>
    \``,
  });

  const engine = createCdpInteractionEngine(pageFor(client), client, {
    touchpadOptions: { initialCursor: { x: 5, y: 5 } },
    pointerOptions: { sleep: async () => {}, sampleIntervalMs: 100 },
  });

  const before = await engine.refresh();
  const outer = before.find((node) => node.name === 'Outer' && node.scrollable);
  const inner = before.find((node) => node.name === 'Inner' && node.scrollable);
  const deep = before.find((node) => node.name === 'Deep target');
  assert.ok(outer && inner && deep);
  assert.equal(inner.viewportVisible, false);
  assert.equal(deep.viewportVisible, false);
  assert.equal(inner.scrollAncestorStructuralId, outer.structuralId);
  assert.equal(deep.scrollAncestorStructuralId, inner.structuralId);

  const result = await engine.acquire(
    { name: 'Deep target', role: 'button' },
    {
      includeDirectional: false,
      revealOptions: {
        timeoutMs: 400,
        pollIntervalMs: 10,
        maxSamples: 12,
        maxAttempts: 3,
        maxScopeDepth: 4,
      },
    },
  );

  assert.equal(result.status, 'reached');
  assert.equal(result.reveal?.status, 'revealed');
  assert.deepEqual(result.reveal?.scrollScopeChain, [outer.id, inner.id]);
  assert.ok((await value(client, `document.querySelector('#outer').scrollTop`)) > 0);
  assert.ok((await value(client, `document.querySelector('#inner').scrollTop`)) > 0);
  assert.equal(result.target?.viewportVisible, true);
  assert.equal(await engine.observer.pointStillTargets(result.target, engine.touchpad.cursor), true);
});
