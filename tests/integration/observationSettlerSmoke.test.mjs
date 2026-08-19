import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { captureCdpBrowserState } from '../../dist/src/browser/browserState.js';
import { waitForObservation } from '../../dist/src/verification/observationSettler.js';

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
    try { const response = await fetch(url); if (response.ok) return response.json(); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 40));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
class Client {
  #ws; #id = 0; #pending = new Map(); #listeners = new Map();
  constructor(url) {
    this.#ws = new WebSocket(url);
    this.#ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const pending = this.#pending.get(message.id);
        if (!pending) return;
        this.#pending.delete(message.id);
        message.error ? pending[1](new Error(JSON.stringify(message.error))) : pending[0](message.result);
        return;
      }
      for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params ?? {});
    });
  }
  async ready() {
    if (this.#ws.readyState === WebSocket.OPEN) return;
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener('open', resolve, { once: true });
      this.#ws.addEventListener('error', reject, { once: true });
    });
  }
  on(event, listener) {
    const set = this.#listeners.get(event) ?? new Set();
    set.add(listener); this.#listeners.set(event, set);
  }
  off(event, listener) { this.#listeners.get(event)?.delete(listener); }
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
  const profile = await mkdtemp(join(tmpdir(), 'observation-settler-profile-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`, 'about:blank',
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
    child.kill('SIGKILL'); await exited;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}
function nodeFromState(state) {
  return [{
    id: 'document', frameId: 'main', focused: false, disabled: false,
    focusable: false, clickable: false, editable: true, scrollable: false,
    capabilities: ['type'], interactionConfidence: 1,
    value: `${state.url}|${state.timeOrigin}`,
  }];
}
async function waitFor(predicate) {
  for (let i = 0; i < 200; i += 1) {
    const value = predicate();
    if (value !== undefined && value !== false) return value;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for Chromium execution-context lifecycle');
}

test('observation settling recovers from a genuinely destroyed Chromium execution context', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => { client.close(); await stop(child, profile); });

  let currentContext;
  let destroyedContext;
  client.on('Runtime.executionContextCreated', ({ context }) => {
    if (context?.auxData?.isDefault) currentContext = context.id;
  });
  client.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    destroyedContext = executionContextId;
  });
  client.on('Runtime.executionContextsCleared', () => {
    if (currentContext !== undefined) destroyedContext = currentContext;
  });
  await client.send('Runtime.enable');
  const oldContext = await waitFor(() => currentContext);
  const beforeState = await captureCdpBrowserState(client);
  const before = nodeFromState(beforeState);

  await client.send('Page.reload', { ignoreCache: true });
  await waitFor(() => destroyedContext === oldContext ? oldContext : undefined);

  let staleAttempted = false;
  const settled = await waitForObservation(async () => {
    if (!staleAttempted) {
      staleAttempted = true;
      await client.send('Runtime.evaluate', {
        expression: 'location.href', contextId: oldContext, returnByValue: true,
      });
    }
    return nodeFromState(await captureCdpBrowserState(client));
  }, before, undefined, {
    timeoutMs: 5000,
    maxSamples: 20,
    maxConsecutiveErrors: 4,
    pollIntervalMs: 10,
  });

  assert.equal(staleAttempted, true);
  assert.equal(settled.matched, true);
  assert.equal(settled.observationErrors >= 1, true);
  assert.equal(settled.errorBudgetExhausted, false);
  assert.notEqual(settled.after[0].value, before[0].value);
});
