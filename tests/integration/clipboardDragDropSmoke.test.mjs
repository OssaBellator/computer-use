import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpClipboardController } from '../../dist/src/browser/clipboardController.js';
import { CdpDragDropController } from '../../dist/src/browser/cdpDragDropController.js';

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
  for (let attempt = 0; attempt < 100; attempt += 1) {
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
  #listeners = new Map();
  calls = [];

  constructor(url) {
    this.#ws = new WebSocket(url);
    this.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        message.error ? pending[1](new Error(JSON.stringify(message.error))) : pending[0](message.result);
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params);
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
    this.calls.push([method, params]);
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      this.#pending.set(id, [resolve, reject]);
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(event, listener) {
    const listeners = this.#listeners.get(event) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(event, listeners);
  }

  off(event, listener) {
    this.#listeners.get(event)?.delete(listener);
  }

  close() { this.#ws.close(); }
}

async function launch() {
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'clipboard-dragdrop-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
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

test('raw CDP transfers browser-native drag data without exposing payload text', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => { client.close(); await stop(child, profile); });

  await client.send('Runtime.evaluate', {
    expression: `(() => {
      document.body.innerHTML = '<div id="source" draggable="true" style="position:absolute;left:20px;top:20px;width:100px;height:60px">source</div><div id="target" style="position:absolute;left:260px;top:20px;width:140px;height:100px">target</div>';
      const source = document.querySelector('#source');
      const target = document.querySelector('#target');
      target.dataset.dropCount = '0';
      source.addEventListener('dragstart', (event) => event.dataTransfer.setData('text/plain', 'synthetic-private-drag-payload'));
      target.addEventListener('dragover', (event) => event.preventDefault());
      target.addEventListener('drop', (event) => {
        event.preventDefault();
        target.dataset.received = event.dataTransfer.getData('text/plain');
        target.dataset.dropCount = String(Number(target.dataset.dropCount || '0') + 1);
      });
    })()`,
  });
  const points = await client.send('Runtime.evaluate', {
    expression: `(() => {
      const center = (id) => { const r = document.querySelector(id).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; };
      return { source: center('#source'), target: center('#target') };
    })()`,
    returnByValue: true,
  });
  const result = await new CdpDragDropController(client).transfer(points.result.value.source, points.result.value.target, {
    interceptTimeoutMs: 1000,
  });
  assert.equal(result.status, 'drop-dispatched');
  assert.equal(JSON.stringify(result).includes('synthetic-private-drag-payload'), false);
  const received = await client.send('Runtime.evaluate', {
    expression: `({ received: document.querySelector('#target').dataset.received, dropCount: document.querySelector('#target').dataset.dropCount })`,
    returnByValue: true,
  });
  assert.equal(received.result.value.received, 'synthetic-private-drag-payload');
  assert.equal(received.result.value.dropCount, '1');
});

test('raw clipboard access remains bounded and never mutates browser permission state', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => { client.close(); await stop(child, profile); });
  const frameTree = await client.send('Page.getFrameTree');
  const frameId = frameTree.frameTree.frame.id;
  const clipboard = new CdpClipboardController(client);
  const write = await clipboard.write(frameId, { text: 'synthetic clipboard value' }, { maxTotalBytes: 64, maxBytesPerType: 64 });
  assert.ok(['written', 'rejected', 'unavailable'].includes(write.status));
  const read = await clipboard.read(frameId, { maxTotalBytes: 64, maxBytesPerType: 64 });
  assert.ok(['read', 'rejected', 'unavailable'].includes(read.status));
  assert.equal(client.calls.some(([method]) => method === 'Browser.setPermission'), false);
  assert.equal(client.calls.some(([method, params]) => method === 'Runtime.callFunctionOn' && params?.userGesture === true), false);
});
