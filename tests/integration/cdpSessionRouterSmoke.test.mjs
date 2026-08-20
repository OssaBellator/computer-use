import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpTargetSessionRouter } from '../../dist/src/browser/cdpSessionRouter.js';

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

class BrowserConnection {
  #ws;
  #id = 0;
  #pending = new Map();
  #listeners = new Map();

  constructor(url) {
    this.#ws = new WebSocket(url);
    this.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        message.error
          ? pending[1](new Error(JSON.stringify(message.error)))
          : pending[0](message.result);
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) {
        listener(message.params, message.sessionId);
      }
    });
  }

  async ready() {
    if (this.#ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener('open', resolve, { once: true });
      this.#ws.addEventListener('error', reject, { once: true });
    });
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.#id;
      this.#pending.set(id, [resolve, reject]);
      this.#ws.send(JSON.stringify({
        id,
        method,
        params,
        ...(sessionId ? { sessionId } : {}),
      }));
    });
  }

  on(event, listener) {
    let listeners = this.#listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  off(event, listener) {
    this.#listeners.get(event)?.delete(listener);
  }

  close() { this.#ws.close(); }
}

async function launch() {
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'cdp-router-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const version = await waitJson(`http://127.0.0.1:${port}/json/version`);
  if (!version.webSocketDebuggerUrl) throw new Error('No browser websocket');
  const connection = new BrowserConnection(version.webSocketDebuggerUrl);
  await connection.ready();
  return { connection, child, profile };
}

async function stop(child, profile) {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise((resolve) => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

test('browser-root CDP router independently controls and observes real Chromium tabs', async (t) => {
  const { connection, child, profile } = await launch();
  t.after(async () => {
    connection.close();
    await stop(child, profile);
  });

  const router = new CdpTargetSessionRouter(connection);
  const targets = await connection.send('Target.getTargets');
  const primary = targets.targetInfos.find((target) => target.type === 'page');
  assert.ok(primary);

  const primarySession = await router.attach(primary.targetId);
  const primaryValue = await primarySession.send('Runtime.evaluate', {
    expression: '1 + 1',
    returnByValue: true,
  });
  assert.equal(primaryValue.result.value, 2);

  const created = await connection.send('Target.createTarget', { url: 'about:blank' });
  const secondarySession = await router.attach(created.targetId);
  await secondarySession.send('Runtime.enable');
  let consoleEvents = 0;
  secondarySession.on('Runtime.consoleAPICalled', () => { consoleEvents += 1; });
  await secondarySession.send('Runtime.evaluate', { expression: `console.log('routed')` });
  for (let i = 0; i < 50 && consoleEvents === 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.equal(consoleEvents, 1);

  await secondarySession.send('Runtime.evaluate', { expression: `document.title = 'Secondary'` });
  const title = await secondarySession.send('Runtime.evaluate', {
    expression: 'document.title',
    returnByValue: true,
  });
  assert.equal(title.result.value, 'Secondary');

  await router.activate(created.targetId);
  await router.detach(secondarySession);
  assert.equal(secondarySession.detached, true);
});
