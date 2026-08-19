import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpRuntimeSnapshotPage } from '../../dist/src/browser/cdpRuntimePage.js';
import { snapshotInteractiveDom } from '../../dist/src/browser/domSnapshot.js';

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
      message.error
        ? pending[1](new Error(JSON.stringify(message.error)))
        : pending[0](message.result);
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
  const profile = await mkdtemp(join(tmpdir(), 'pure-cdp-page-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
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

async function waitForChildFrame(client) {
  for (let i = 0; i < 100; i += 1) {
    const tree = await client.send('Page.getFrameTree');
    if (tree.frameTree.childFrames?.length) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for iframe');
}

test('pure CDP snapshot page exposes semantic controls across real Chromium frames', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `document.body.innerHTML = '<button aria-label="Main Action">Main</button><iframe id="child"></iframe>';
      document.querySelector('#child').srcdoc = '<button aria-label="Frame Action">Frame</button>';`,
  });
  await waitForChildFrame(client);

  const page = new CdpRuntimeSnapshotPage(client);
  await page.refresh();
  const frames = page.frames();
  assert.equal(frames.length, 2);
  assert.equal(frames[1].parentFrame(), frames[0]);

  const nodes = await snapshotInteractiveDom(page);
  const main = nodes.find((node) => node.name === 'Main Action');
  const childNode = nodes.find((node) => node.name === 'Frame Action');
  assert.ok(main);
  assert.ok(childNode);
  assert.equal(main.frameId, 'main');
  assert.equal(childNode.frameId, 'frame-1');
  assert.equal(childNode.parentFrameId, 'main');
  assert.equal(childNode.capabilities.includes('activate'), true);

  // Keep the cached main-frame isolated world, replace the document, then prove
  // evaluate() recreates the destroyed context rather than exposing staleness.
  const mainFrame = frames[0];
  assert.equal(await mainFrame.evaluate(() => document.readyState), 'complete');
  await client.send('Page.reload');
  for (let i = 0; i < 100; i += 1) {
    try {
      if (await mainFrame.evaluate(() => document.readyState) === 'complete') break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await mainFrame.evaluate(() => document.readyState), 'complete');
});
