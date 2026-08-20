import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpTargetController } from '../../dist/src/browser/targetController.js';
import { TaskRuntime } from '../../dist/src/agent/taskRuntime.js';

async function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
async function waitJson(url) { for (let i = 0; i < 100; i += 1) { try { const response = await fetch(url); if (response.ok) { const value = await response.json(); if (value.length) return value; } } catch {} await new Promise((resolve) => setTimeout(resolve, 40)); } throw new Error(`Timed out waiting for ${url}`); }
class Client {
  #ws; #id = 0; #pending = new Map(); #listeners = new Map();
  constructor(url) { this.#ws = new WebSocket(url); this.#ws.addEventListener('message', (event) => { const message = JSON.parse(event.data); if (message.id !== undefined) { const pending = this.#pending.get(message.id); if (!pending) return; this.#pending.delete(message.id); message.error ? pending[1](new Error(JSON.stringify(message.error))) : pending[0](message.result); return; } for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params ?? {}); }); }
  async ready() { if (this.#ws.readyState === WebSocket.OPEN) return; await new Promise((resolve, reject) => { this.#ws.addEventListener('open', resolve, { once: true }); this.#ws.addEventListener('error', reject, { once: true }); }); }
  on(event, listener) { const set = this.#listeners.get(event) ?? new Set(); set.add(listener); this.#listeners.set(event, set); }
  off(event, listener) { this.#listeners.get(event)?.delete(listener); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.#id; this.#pending.set(id, [resolve, reject]); this.#ws.send(JSON.stringify({ id, method, params })); }); }
  close() { this.#ws.close(); }
}
async function launch() { const port = await freePort(); const profile = await mkdtemp(join(tmpdir(), 'target-lifecycle-smoke-')); const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' }); const pages = await waitJson(`http://127.0.0.1:${port}/json/list`); const target = pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl); if (!target) throw new Error('No Chromium page target'); const client = new Client(target.webSocketDebuggerUrl); await client.ready(); return { client, child, profile }; }
async function stop(child, profile) { if (child.exitCode === null && child.signalCode === null) { const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGKILL'); await exited; } await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); }
async function waitFor(predicate) { for (let i = 0; i < 100; i += 1) { if (predicate()) return; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error('Timed out waiting for target lifecycle'); }

test('real Chromium target lifecycle tracks and closes a secondary page without retaining its URL', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => { client.close(); await stop(child, profile); });
  const targets = new CdpTargetController(client);
  await targets.start();
  const before = targets.summary();
  assert.equal(before.pages >= 1, true);

  const created = await targets.createPage('about:blank#secondary');
  assert.equal(created.status, 'created');
  await waitFor(() => targets.summary().unattachedPages >= 1);
  const secondary = targets.summary().latestUnattachedPage;
  assert.ok(secondary);
  assert.equal(JSON.stringify(targets.targets()).includes('secondary'), false);

  const closed = await targets.closeLatestUnattachedPage();
  assert.equal(closed?.status, 'closed');
  await waitFor(() => !targets.targets().some((target) => target.targetId === secondary.targetId));
});

test('task runtime opens and closes a real Chromium secondary tab as bounded topology actions', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => { client.close(); await stop(child, profile); });
  const targets = new CdpTargetController(client);
  const engine = {
    async prepare() { await targets.start(); },
    async refresh() { return []; },
    targetState() { return targets.summary(); },
    async createPageTarget(url) { return targets.createPage(url); },
    async closeLatestUnattachedPage() { return targets.closeLatestUnattachedPage(); },
    async activate() { throw new Error('not used'); },
    async typeInto() { throw new Error('not used'); },
  };
  const destination = 'about:blank#task-secondary';
  const result = await new TaskRuntime(engine).run({
    version: 1,
    entry: 'open',
    inputs: ['destination'],
    steps: [
      { id: 'open', kind: 'open-tab', url: { input: 'destination' }, next: 'wait-open' },
      { id: 'wait-open', kind: 'wait', condition: { kind: 'targets', state: { unattachedPageCountAtLeast: 1 } }, next: 'close', maxPolls: 20, pollIntervalMs: 10 },
      { id: 'close', kind: 'close-latest-tab', next: 'wait-closed' },
      { id: 'wait-closed', kind: 'wait', condition: { kind: 'not', predicate: { kind: 'targets', state: { unattachedPageCountAtLeast: 1 } } }, next: 'done', maxPolls: 20, pollIntervalMs: 10 },
      { id: 'done', kind: 'complete' },
    ],
  }, { destination });
  assert.equal(result.status, 'completed');
  assert.deepEqual(result.trace.map((entry) => entry.outcome), [
    'target-created', 'wait-satisfied', 'target-closed', 'wait-satisfied', 'completed',
  ]);
  assert.equal(JSON.stringify(result.trace).includes(destination), false);
  assert.equal(targets.summary().unattachedPages, 0);
  assert.equal(targets.summary().pages >= 1, true);
});
