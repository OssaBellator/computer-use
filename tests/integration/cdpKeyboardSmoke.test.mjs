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
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url) {
  for (let i = 0; i < 100; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return await response.json();
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

class CdpClient {
  #ws;
  #id = 0;
  #pending = new Map();
  constructor(url) {
    this.#ws = new WebSocket(url);
    this.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      const pending = message.id ? this.#pending.get(message.id) : undefined;
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
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.#ws.close(); }
}

async function launchChromium() {
  const chromium = process.env.CHROMIUM_BIN || '/usr/bin/chromium';
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'browser-automation-keyboard-'));
  const child = spawn(chromium, [
    '--headless=new', '--no-sandbox',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  const pages = await waitForJson(`http://127.0.0.1:${port}/json/list`);
  const target = pages.find((page) => page.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('No Chromium page target');
  const client = new CdpClient(target.webSocketDebuggerUrl);
  await client.ready();
  return { client, child, profile };
}

async function stopChromium({ client, child, profile }) {
  client.close();
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

test('live Chromium receives Ctrl+A replacement and shifted US-layout glyph metadata', async (t) => {
  const browser = await launchChromium();
  t.after(() => stopChromium(browser));
  await browser.client.send('Runtime.evaluate', {
    expression: `document.body.innerHTML='<input id="x" value="old">';x.focus();window.ev=[];x.addEventListener('keydown',e=>ev.push({key:e.key,code:e.code,shift:e.shiftKey,ctrl:e.ctrlKey}))`,
  });

  const input = new CdpInputAdapter(browser.client);
  await input.pressKey('Control+a');
  await input.typeText('Z!');

  assert.equal(await value(browser.client, 'x.value'), 'Z!');
  const events = await value(browser.client, 'ev');
  assert.ok(events.some((event) => event.key === 'a' && event.ctrl === true));
  assert.ok(events.some((event) => event.key === 'Z' && event.code === 'KeyZ' && event.shift === true));
  assert.ok(events.some((event) => event.key === '!' && event.code === 'Digit1' && event.shift === true));
});
