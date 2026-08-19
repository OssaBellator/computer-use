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
  const profile = await mkdtemp(join(tmpdir(), 'engine-smoke-'));
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

test('CDP interaction engine semantically acquires and verifies a live browser target', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `document.body.innerHTML='<button id="first" style="position:absolute;left:100px;top:80px;width:100px;height:40px">First</button><button id="target" style="position:absolute;left:420px;top:260px;width:120px;height:50px">Acquire me</button>'`,
  });

  const engine = createCdpInteractionEngine(pageFor(client), client, {
    touchpadOptions: { initialCursor: { x: 5, y: 5 } },
    pointerOptions: { sleep: async () => {}, sampleIntervalMs: 100 },
  });
  const result = await engine.acquire({ name: 'Acquire me', role: 'button', visible: true }, {
    includeDirectional: false,
  });

  assert.equal(result.status, 'reached');
  assert.match(result.target?.id ?? '', /^backend:\d+$/);
  assert.equal(typeof result.target?.backendNodeId, 'number');
  assert.equal(result.execution?.executed.at(-1)?.edge.kind, 'pointer-move');
  const cursor = engine.touchpad.cursor;
  const rect = result.target.mainViewportRect;
  assert.ok(cursor.x >= rect.x && cursor.x <= rect.x + rect.width);
  assert.ok(cursor.y >= rect.y && cursor.y <= rect.y + rect.height);
  assert.equal(await engine.observer.pointStillTargets(result.target, cursor), true);
});

test('CDP interaction engine verifies semantic activation and text entry in Chromium', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `(() => {
      document.body.innerHTML = '<button id="toggle" aria-expanded="false" style="margin:40px;width:120px;height:44px">Toggle</button><input id="text" aria-label="Text" style="display:block;margin:40px;width:180px;height:30px" value="">';
      document.querySelector('#toggle').addEventListener('click', () => {
        document.querySelector('#toggle').setAttribute('aria-expanded', 'true');
      });
    })()`,
  });

  const engine = createCdpInteractionEngine(pageFor(client), client, {
    touchpadOptions: { initialCursor: { x: 5, y: 5 } },
    pointerOptions: { sleep: async () => {}, sampleIntervalMs: 100 },
  });

  const activated = await engine.activate(
    { name: 'Toggle', capability: 'activate', visible: true },
    {
      includeDirectional: false,
      maxSamples: 10,
      pollIntervalMs: 5,
      timeoutMs: 300,
    },
  );
  assert.equal(activated.status, 'verified');
  assert.equal(activated.action?.delta.changedStates.some(
    (change) => change.field === 'expanded' && change.after === true,
  ), true);
  assert.equal(await value(client, `document.querySelector('#toggle').getAttribute('aria-expanded')`), 'true');

  const typed = await engine.typeInto(
    { name: 'Text', capability: 'type', visible: true },
    'abc',
    {
      includeDirectional: false,
      expectedValue: 'abc',
      maxSamples: 10,
      pollIntervalMs: 5,
      timeoutMs: 300,
    },
  );
  assert.equal(typed.status, 'verified');
  assert.equal(typed.action?.delta.changedValues.some(
    (change) => change.after === 'abc',
  ), true);
  assert.equal(await value(client, `document.querySelector('#text').value`), 'abc');
});
