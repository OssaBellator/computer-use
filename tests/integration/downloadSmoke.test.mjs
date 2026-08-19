import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import net from 'node:net';
import { CdpDownloadController } from '../../dist/src/browser/downloadController.js';
import { TaskRuntime } from '../../dist/src/agent/taskRuntime.js';

async function freePort() { return new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); }); }
async function waitJson(url) { for (let i = 0; i < 100; i += 1) { try { const response = await fetch(url); if (response.ok) return response.json(); } catch {} await new Promise((resolve) => setTimeout(resolve, 40)); } throw new Error(`Timed out waiting for ${url}`); }
class Client {
  #ws; #id = 0; #pending = new Map(); #listeners = new Map();
  constructor(url) { this.#ws = new WebSocket(url); this.#ws.addEventListener('message', (event) => { const message = JSON.parse(event.data); if (message.id !== undefined) { const pending = this.#pending.get(message.id); if (!pending) return; this.#pending.delete(message.id); message.error ? pending[1](new Error(JSON.stringify(message.error))) : pending[0](message.result); return; } for (const listener of this.#listeners.get(message.method) ?? []) listener(message.params ?? {}); }); }
  async ready() { if (this.#ws.readyState === WebSocket.OPEN) return; await new Promise((resolve, reject) => { this.#ws.addEventListener('open', resolve, { once: true }); this.#ws.addEventListener('error', reject, { once: true }); }); }
  on(event, listener) { const set = this.#listeners.get(event) ?? new Set(); set.add(listener); this.#listeners.set(event, set); }
  off(event, listener) { this.#listeners.get(event)?.delete(listener); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.#id; this.#pending.set(id, [resolve, reject]); this.#ws.send(JSON.stringify({ id, method, params })); }); }
  close() { this.#ws.close(); }
}
async function launch() { const port = await freePort(); const profile = await mkdtemp(join(tmpdir(), 'download-smoke-profile-')); const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', ['--headless=new', '--no-sandbox', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' }); const pages = await waitJson(`http://127.0.0.1:${port}/json/list`); const target = pages.find((page) => page.type === 'page' && page.webSocketDebuggerUrl); if (!target) throw new Error('No Chromium page target'); const client = new Client(target.webSocketDebuggerUrl); await client.ready(); return { client, child, profile }; }
async function stop(child, ...paths) { if (child.exitCode === null && child.signalCode === null) { const exited = new Promise((resolve) => child.once('exit', resolve)); child.kill('SIGKILL'); await exited; } for (const path of paths) await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 }); }

test('real Chromium download verification uses opaque GUID filenames and task completion evidence', async (t) => {
  const { client, child, profile } = await launch();
  const downloadPath = await mkdtemp(join(tmpdir(), 'download-smoke-files-'));
  t.after(async () => { client.close(); await stop(child, profile, downloadPath); });
  const downloads = new CdpDownloadController(client, { downloadPath });
  const engine = {
    async prepare() { await downloads.start(); },
    async refresh() { return []; },
    downloadState() { return downloads.summary(); },
    async activate() {
      await client.send('Runtime.evaluate', {
        expression: `(() => { const blob = new Blob(['frontier-download'], {type:'text/plain'}); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '../evil.txt'; document.body.append(a); a.click(); return true; })()`,
        returnByValue: true,
      });
      return { status: 'verified', target: null };
    },
    async typeInto() { throw new Error('not used'); },
  };
  const result = await new TaskRuntime(engine).run({
    version: 1,
    entry: 'download',
    steps: [
      { id: 'download', kind: 'activate', target: 'download-link', risk: 'external-side-effect', next: 'wait' },
      { id: 'wait', kind: 'wait', condition: { kind: 'downloads', state: { completedCountAtLeast: 1 } }, next: 'done', maxPolls: 100, pollIntervalMs: 10 },
      { id: 'done', kind: 'complete' },
    ],
  }, {}, { maxRisk: 'external-side-effect' });
  assert.equal(result.status, 'completed');
  const completed = downloads.summary().latestCompleted;
  assert.ok(completed);
  const path = downloads.completedPath(completed.guid);
  assert.ok(path);
  assert.equal(basename(path), completed.guid);
  assert.equal(await readFile(path, 'utf8'), 'frontier-download');
  assert.deepEqual(await readdir(downloadPath), [completed.guid]);
  assert.equal(JSON.stringify(downloads.downloads()).includes('evil.txt'), false);
  assert.equal(JSON.stringify(result.trace).includes('evil.txt'), false);
});
