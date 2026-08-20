import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { snapshotInteractiveDom } from '../../dist/src/browser/domSnapshot.js';
import { captureCdpIdentityIndex, enrichInteractionNodesWithCdpIdentity } from '../../dist/src/browser/cdpIdentity.js';
import { findHitTestedTargetPoint, pointHitsInteractionNode } from '../../dist/src/browser/hitTesting.js';

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url, attempts = 80) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw lastError ?? new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
  #ws;
  #nextId = 1;
  #pending = new Map();

  constructor(url) {
    this.#ws = new WebSocket(url);
    this.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
      else pending.resolve(message.result);
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
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.#ws.close();
  }
}

async function launchChromium() {
  const chromium = process.env.CHROMIUM_BIN || '/usr/bin/chromium';
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'browser-automation-chromium-'));
  const child = spawn(chromium, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  try {
    await waitForJson(`http://127.0.0.1:${port}/json/version`);
    const pages = await waitForJson(`http://127.0.0.1:${port}/json/list`);
    const target = pages.find((page) => page.type === 'page');
    if (!target?.webSocketDebuggerUrl) throw new Error('No Chromium page target');
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.ready();
    return { client, child, profile };
  } catch (error) {
    await stopChromium(child, profile);
    throw error;
  }
}

async function stopChromium(child, profile) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

function snapshotPage(client) {
  const frame = {
    async evaluate(pageFunction, arg) {
      const invocation = arg === undefined
        ? `(${pageFunction.toString()})()`
        : `(${pageFunction.toString()})(${JSON.stringify(arg)})`;
      const result = await client.send('Runtime.evaluate', {
        expression: invocation,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
      }
      return result.result.value;
    },
  };
  return { frames: () => [frame] };
}

test('live Chromium snapshot handles shadow focus, stable identity, ARIA state, and occlusion', async (t) => {
  const { client, child, profile } = await launchChromium();
  t.after(async () => {
    client.close();
    await stopChromium(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `(() => {
      document.body.innerHTML = '<button id="outer" aria-expanded="false">Outer</button><div id="host"></div>';
      const root = document.querySelector('#host').attachShadow({ mode: 'open' });
      root.innerHTML = '<span id="label">Shadow action</span><button id="inside" aria-labelledby="label">Go</button>';
      root.querySelector('#inside').focus();
    })()`,
  });

  const page = snapshotPage(client);
  const before = await snapshotInteractiveDom(page);
  const inside = before.find((node) => node.name === 'Shadow action');
  const outer = before.find((node) => node.name === 'Outer');
  assert.ok(inside);
  assert.match(inside.id, /::shadow/);
  assert.equal(inside.focused, true);
  assert.equal(outer?.expanded, false);

  const identitiesBefore = await captureCdpIdentityIndex(client);
  const [stableInside] = enrichInteractionNodesWithCdpIdentity([inside], identitiesBefore);
  assert.equal(typeof stableInside.backendNodeId, 'number');
  assert.ok(stableInside.axNodeId);
  assert.equal(stableInside.role, 'button');
  assert.equal(stableInside.name, 'Shadow action');
  const stableBackendNodeId = stableInside.backendNodeId;

  await client.send('Runtime.evaluate', {
    expression: `document.querySelector('#outer').setAttribute('aria-expanded', 'true')`,
  });
  const after = await snapshotInteractiveDom(page);
  assert.equal(after.find((node) => node.name === 'Outer')?.expanded, true);
  const identitiesAfter = await captureCdpIdentityIndex(client);
  const [stableInsideAfter] = enrichInteractionNodesWithCdpIdentity([inside], identitiesAfter);
  assert.equal(stableInsideAfter.backendNodeId, stableBackendNodeId);

  await client.send('Runtime.evaluate', {
    expression: `(() => {
      document.body.innerHTML = '<button id="target" style="position:absolute;left:10px;top:10px;width:120px;height:40px">Target</button><div style="position:absolute;left:50px;top:10px;width:50px;height:40px;z-index:10;background:black"></div>';
    })()`,
  });
  const occluded = await snapshotInteractiveDom(page);
  const target = occluded.find((node) => node.name === 'Target');
  assert.ok(target);
  const centerHit = await pointHitsInteractionNode(page.frames()[0], target, { x: 70, y: 30 });
  assert.equal(centerHit.hit, false);
  const validatedPoint = await findHitTestedTargetPoint(
    page.frames()[0],
    target,
    { x: 0, y: 0, width: 800, height: 600 },
  );
  assert.deepEqual(validatedPoint, { x: 42, y: 30 });
});
