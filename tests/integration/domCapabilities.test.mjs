import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { snapshotInteractiveDom } from '../../dist/src/browser/domSnapshot.js';

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
  let lastError;
  for (let i = 0; i < 80; i += 1) {
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
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { this.#ws.close(); }
}

async function launchChromium() {
  const chromium = process.env.CHROMIUM_BIN || '/usr/bin/chromium';
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'browser-automation-capabilities-'));
  const child = spawn(chromium, [
    '--headless=new', '--no-sandbox', '--disable-gpu',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  try {
    const pages = await waitForJson(`http://127.0.0.1:${port}/json/list`);
    const target = pages.find((page) => page.type === 'page');
    if (!target?.webSocketDebuggerUrl) throw new Error('No Chromium page target');
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.ready();
    return { client, child, profile };
  } catch (error) {
    if (child.exitCode === null) child.kill('SIGKILL');
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
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

function snapshotPage(client) {
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
  };
  return { frames: () => [frame] };
}

test('live snapshot distinguishes text entry from native activation controls', async (t) => {
  const browser = await launchChromium();
  t.after(() => stopChromium(browser));
  await browser.client.send('Runtime.evaluate', {
    expression: `document.body.innerHTML = \`
      <input aria-label="Text" value="hello">
      <input aria-label="Check" type="checkbox">
      <select aria-label="Select"><option>One</option></select>
      <div aria-label="Editor" contenteditable="true">editable value</div>
    \``,
  });

  const nodes = await snapshotInteractiveDom(snapshotPage(browser.client));
  const text = nodes.find((node) => node.name === 'Text');
  const check = nodes.find((node) => node.name === 'Check');
  const select = nodes.find((node) => node.name === 'Select');
  const editor = nodes.find((node) => node.name === 'Editor');

  assert.ok(text && check && select && editor);
  assert.equal(text.editable, true);
  assert.equal(text.clickable, false);
  assert.ok(text.capabilities.includes('type'));

  assert.equal(check.editable, false);
  assert.equal(check.clickable, true);
  assert.ok(check.capabilities.includes('activate'));
  assert.equal(check.checked, false);

  assert.equal(select.editable, false);
  assert.equal(select.clickable, true);
  assert.ok(select.capabilities.includes('activate'));

  assert.equal(editor.editable, true);
  assert.equal(editor.value, 'editable value');
  assert.ok(editor.capabilities.includes('type'));
});
