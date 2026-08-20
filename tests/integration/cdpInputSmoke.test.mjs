import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpInputAdapter } from '../../dist/src/input/cdpInputAdapter.js';

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
  const profile = await mkdtemp(join(tmpdir(), 'input-smoke-'));
  const child = spawn('/usr/bin/chromium', [
    '--headless=new', '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const pages = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const target = pages.find((page) => page.type === 'page');
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

async function value(client, expression) {
  const result = await client.send('Runtime.evaluate', { expression, returnByValue: true });
  return result.result.value;
}

test('CDP input adapter drives focus, typing, click activation, and wheel scroll in Chromium', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `document.body.innerHTML='<button id="first">First</button><input id="text"><button id="click">Click</button><div style="height:2000px"></div>';document.querySelector('#click').onclick=()=>document.querySelector('#click').dataset.clicked='yes'`,
  });
  const input = new CdpInputAdapter(client);
  await input.pressKey('Tab');
  assert.equal(await value(client, 'document.activeElement.id'), 'first');
  await input.pressKey('Tab');
  assert.equal(await value(client, 'document.activeElement.id'), 'text');
  await input.typeText('abc');
  assert.equal(await value(client, `document.querySelector('#text').value`), 'abc');

  const rect = await value(client, `(()=>{const r=document.querySelector('#click').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await input.movePointer(rect);
  await input.pointerDown();
  await input.pointerUp();
  assert.equal(await value(client, `document.querySelector('#click').dataset.clicked`), 'yes');

  await input.scroll({ x: 0, y: 500 });
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.ok((await value(client, 'window.scrollY')) > 0);
});
