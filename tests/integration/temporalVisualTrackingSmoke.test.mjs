import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { CdpVisualObserver } from '../../dist/src/browser/visualObserver.js';
import { VisualMotionSampler } from '../../dist/src/browser/visualDiff.js';
import {
  VisualMotionTracker,
  projectVisualMotionTrack,
} from '../../dist/src/browser/visualMotionTracker.js';

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
  const profile = await mkdtemp(join(tmpdir(), 'temporal-visual-tracking-'));
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

test('temporal tracker estimates velocity from real Chromium canvas screenshots', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Emulation.setDeviceMetricsOverride', {
    width: 160,
    height: 80,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await client.send('Runtime.evaluate', {
    expression: `
      document.body.style.margin = '0';
      document.body.innerHTML = '<canvas id="game" width="128" height="64"></canvas>';
      window.__draw = (x) => {
        const canvas = document.querySelector('#game');
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = 'black';
        ctx.fillRect(0, 0, 128, 64);
        ctx.fillStyle = 'white';
        ctx.fillRect(x, 24, 8, 8);
      };
      window.__draw(8);
    `,
  });

  const sampler = new VisualMotionSampler(new CdpVisualObserver(client), {
    capture: {
      clip: { x: 0, y: 0, width: 128, height: 64 },
      maxBytes: 256 * 1024,
    },
    tileSizePx: 8,
    pixelStride: 1,
    pixelDeltaThreshold: 20,
    tileChangedFraction: 0.5,
  });
  const tracker = new VisualMotionTracker({ velocityAlpha: 1 });

  const baseline = await sampler.sample();
  const baselineFrame = tracker.update(baseline, 0);
  assert.deepEqual(baselineFrame.tracks, []);

  await client.send('Runtime.evaluate', { expression: 'window.__draw(16)' });
  const firstMotion = tracker.update(await sampler.sample(), 100);
  assert.equal(firstMotion.tracks.length, 1);
  assert.deepEqual(firstMotion.tracks[0].rect, { x: 8, y: 24, width: 16, height: 8 });

  await client.send('Runtime.evaluate', { expression: 'window.__draw(24)' });
  const secondMotion = tracker.update(await sampler.sample(), 200);
  assert.equal(secondMotion.tracks.length, 1);
  assert.equal(secondMotion.tracks[0].id, firstMotion.tracks[0].id);
  assert.deepEqual(secondMotion.tracks[0].velocityPxPerSecond, { x: 80, y: 0 });
  assert.deepEqual(
    projectVisualMotionTrack(secondMotion.tracks[0], 100),
    { x: 24, y: 24, width: 16, height: 8 },
  );
});
