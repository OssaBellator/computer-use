import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpTargetSessionRouter } from '../../dist/src/browser/cdpSessionRouter.js';
import { MultiPageCdpAgent } from '../../dist/src/engine/multiPageCdpAgent.js';

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
        id, method, params, ...(sessionId ? { sessionId } : {}),
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

  off(event, listener) { this.#listeners.get(event)?.delete(listener); }
  close() { this.#ws.close(); }
}

async function launch() {
  const port = await freePort();
  const profile = await mkdtemp(join(tmpdir(), 'multi-page-agent-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const version = await waitJson(`http://127.0.0.1:${port}/json/version`);
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

async function seedTarget(router, targetId, label) {
  const session = await router.attach(targetId);
  try {
    await session.send('Runtime.evaluate', {
      expression: `document.body.innerHTML = '<button aria-label="${label}">${label}</button>'`,
    });
  } finally {
    await router.detach(session);
  }
}

test('multi-page agent switches the active semantic engine between real Chromium tabs', async (t) => {
  const { connection, child, profile } = await launch();
  const router = new CdpTargetSessionRouter(connection);
  const agent = new MultiPageCdpAgent(router, { coalesceSnapshots: false });
  t.after(async () => {
    await agent.shutdown().catch(() => {});
    connection.close();
    await stop(child, profile);
  });

  const initialTargets = await connection.send('Target.getTargets');
  const primary = initialTargets.targetInfos.find((target) => target.type === 'page');
  assert.ok(primary);
  const created = await connection.send('Target.createTarget', { url: 'about:blank' });
  assert.ok(created.targetId);

  await seedTarget(router, primary.targetId, 'Primary Action');
  await seedTarget(router, created.targetId, 'Secondary Action');
  await agent.start();

  const primarySwitch = await agent.switchTo(primary.targetId);
  assert.equal(primarySwitch.status, 'switched');
  const primaryNodes = await agent.activeEngine.refresh();
  assert.equal(primaryNodes.some((node) => node.name === 'Primary Action'), true);
  assert.equal(primaryNodes.some((node) => node.name === 'Secondary Action'), false);

  const secondarySwitch = await agent.switchTo(created.targetId);
  assert.equal(secondarySwitch.status, 'switched');
  const secondaryNodes = await agent.activeEngine.refresh();
  assert.equal(secondaryNodes.some((node) => node.name === 'Secondary Action'), true);
  assert.equal(secondaryNodes.some((node) => node.name === 'Primary Action'), false);

  assert.equal(agent.summary().activeTargetId, created.targetId);
  assert.equal(agent.summary().attachedPages, 2);
  const serialized = JSON.stringify(agent.summary());
  assert.equal(serialized.includes('Primary Action'), false);
  assert.equal(serialized.includes('Secondary Action'), false);
});
