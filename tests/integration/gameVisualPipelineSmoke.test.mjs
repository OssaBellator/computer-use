import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpGameVisualPipeline } from '../../dist/src/browser/gameVisualPipeline.js';
import { projectVisualMotionTrack } from '../../dist/src/browser/visualMotionTracker.js';

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
  const profile = await mkdtemp(join(tmpdir(), 'game-visual-pipeline-'));
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
    child.kill('SIGKILL');
    await exited;
  }
  await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 25 });
}

test('game visual pipeline composes acquisition, motion tracking, resize reset, and renderer reacquisition', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 240,
    height: 140,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.send('Runtime.evaluate', {
    expression: `
      document.body.style.margin = '0';
      document.body.innerHTML = '<canvas id="game" width="128" height="64" style="display:block;width:128px;height:64px"></canvas>';
      window.__draw = (x) => {
        const canvas = document.querySelector('#game');
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'white';
        ctx.fillRect(x, 24, 8, 8);
      };
      window.__draw(8);
    `,
  });

  const pipeline = new CdpGameVisualPipeline(client, {
    capture: { maxBytes: 256 * 1024 },
    motion: {
      tileSizePx: 8,
      pixelStride: 1,
      pixelDeltaThreshold: 20,
      tileChangedFraction: 0.5,
    },
    tracking: { velocityAlpha: 1 },
  });

  const baseline = await pipeline.sample(0);
  assert.equal(baseline.status, 'baseline');
  assert.equal(baseline.rendererGeneration, 1);
  assert.equal(baseline.perceptionGeneration, 1);
  assert.deepEqual(baseline.tracking?.tracks, []);

  await client.send('Runtime.evaluate', { expression: 'window.__draw(16)' });
  const firstMotion = await pipeline.sample(100);
  assert.equal(firstMotion.status, 'sampled');
  assert.equal(firstMotion.rendererGeneration, 1);
  assert.equal(firstMotion.perceptionGeneration, 1);
  assert.equal(firstMotion.tracking?.tracks.length, 1);

  await client.send('Runtime.evaluate', { expression: 'window.__draw(24)' });
  const secondMotion = await pipeline.sample(200);
  assert.equal(secondMotion.status, 'sampled');
  assert.equal(secondMotion.tracking?.tracks.length, 1);
  const track = secondMotion.tracking.tracks[0];
  assert.deepEqual(track.velocityPxPerSecond, { x: 80, y: 0 });
  assert.deepEqual(
    projectVisualMotionTrack(track, 100),
    { x: 24, y: 24, width: 16, height: 8 },
  );

  await client.send('Runtime.evaluate', {
    expression: `
      const canvas = document.querySelector('#game');
      canvas.style.width = '160px';
      canvas.style.height = '80px';
    `,
  });
  const resized = await pipeline.sample(300);
  assert.equal(resized.status, 'baseline');
  assert.equal(resized.baselineReset, true);
  assert.equal(resized.rendererGeneration, 1);
  assert.equal(resized.perceptionGeneration, 2);
  assert.deepEqual(resized.tracking?.tracks, []);
  assert.deepEqual(
    [resized.lease.region?.clip.width, resized.lease.region?.clip.height],
    [160, 80],
  );

  await client.send('Runtime.evaluate', {
    expression: `
      document.querySelector('#game').outerHTML = '<canvas id="game" width="160" height="80" style="display:block;width:160px;height:80px"></canvas>';
      window.__draw = (x) => {
        const canvas = document.querySelector('#game');
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = 'white';
        ctx.fillRect(x, 32, 8, 8);
      };
      window.__draw(16);
    `,
  });
  const replaced = await pipeline.sample(400);
  assert.equal(replaced.status, 'baseline');
  assert.equal(replaced.baselineReset, true);
  assert.equal(replaced.rendererGeneration, 2);
  assert.equal(replaced.perceptionGeneration, 3);
  assert.deepEqual(replaced.tracking?.tracks, []);
});
