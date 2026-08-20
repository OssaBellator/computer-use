import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { observeMediaState } from '../../dist/src/browser/mediaState.js';
import { CdpMediaController } from '../../dist/src/browser/mediaController.js';
import { observePermissionState } from '../../dist/src/browser/permissionState.js';

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
      message.error ? pending[1](new Error(JSON.stringify(message.error))) : pending[0](message.result);
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
  const profile = await mkdtemp(join(tmpdir(), 'media-permission-state-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
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

function wavDataUri() {
  const sampleRate = 8000;
  const seconds = 0.5;
  const samples = sampleRate * seconds;
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(dataSize, 40);
  return `data:audio/wav;base64,${buffer.toString('base64')}`;
}

async function waitForChildFrame(client) {
  for (let i = 0; i < 100; i += 1) {
    const tree = await client.send('Page.getFrameTree');
    if (tree?.frameTree?.childFrames?.length) return tree.frameTree;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for synthetic child frame');
}

test('raw CDP observes and safely controls synthetic media/fullscreen and permission state', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `(() => {
      const audio = document.createElement('audio');
      audio.id = 'tone';
      audio.setAttribute('aria-label', 'Synthetic tone');
      audio.controls = true;
      audio.src = ${JSON.stringify(wavDataUri())};
      document.body.append(audio);
      audio.load();
      const frame = document.createElement('iframe');
      frame.id = 'policy-frame';
      frame.setAttribute('allow', "camera 'none'; microphone 'none'");
      frame.srcdoc = '<!doctype html><p>permission policy child</p>';
      document.body.append(frame);
    })()`,
  });
  const frameTree = await waitForChildFrame(client);
  const mainFrameId = frameTree.frame.id;
  const childFrameId = frameTree.childFrames[0].frame.id;
  await client.send('Runtime.evaluate', {
    expression: `new Promise((resolve) => {
      const audio = document.querySelector('#tone');
      if (audio.readyState >= 1) resolve(true);
      else audio.addEventListener('loadedmetadata', () => resolve(true), { once: true });
    })`,
    awaitPromise: true,
    returnByValue: true,
  });

  const before = await observeMediaState(client);
  assert.equal(before.media.length, 1);
  assert.equal(before.media[0].identity.id, 'tone');
  assert.equal(before.media[0].playbackState, 'paused');
  assert.ok(before.media[0].durationSeconds > 0 && before.media[0].durationSeconds <= 1);
  assert.equal(before.fullscreen.pageState, 'inactive');

  const controller = new CdpMediaController(client);
  assert.equal((await controller.setMuted(before.media[0].identity, true)).status, 'verified');
  assert.equal((await controller.setVolume(before.media[0].identity, 0.35)).status, 'verified');
  assert.equal((await controller.setPlaybackRate(before.media[0].identity, 1.5)).status, 'verified');
  assert.equal((await controller.play(before.media[0].identity)).status, 'verified');

  const playing = await observeMediaState(client);
  assert.equal(playing.media[0].playbackState, 'playing');
  assert.equal(playing.media[0].muted, true);
  assert.equal(playing.media[0].volume, 0.35);
  assert.equal(playing.media[0].playbackRate, 1.5);
  assert.equal(playing.activeMedia?.backendNodeId, before.media[0].identity.backendNodeId);

  const fullscreen = await controller.requestFullscreen(playing.media[0].identity);
  assert.ok(['verified', 'rejected', 'verification-failed'].includes(fullscreen.status));
  const fullscreenSnapshot = await observeMediaState(client);
  if (fullscreen.status === 'verified') {
    assert.equal(fullscreenSnapshot.fullscreen.pageState, 'active');
    assert.equal(fullscreenSnapshot.fullscreen.owner?.backendNodeId, playing.media[0].identity.backendNodeId);
    assert.equal((await controller.exitFullscreen(fullscreenSnapshot.fullscreen.owner.frameId)).status, 'verified');
  } else {
    // Current headless Chromium may decline document fullscreen even with a CDP user gesture.
    // The controller must return boundedly rather than hanging or synthesizing page events.
    assert.notEqual(fullscreenSnapshot.fullscreen.pageState, 'active');
  }

  const permissions = await observePermissionState(client, { permissions: ['camera', 'microphone', 'notifications'] });
  const main = permissions.frames.find((frame) => frame.frameId === mainFrameId);
  const policyChild = permissions.frames.find((frame) => frame.frameId === childFrameId);
  assert.ok(main);
  assert.ok(policyChild);
  assert.equal(typeof main.secureContext, 'boolean');
  const childByName = new Map(policyChild.permissions.map((permission) => [permission.name, permission]));
  assert.equal(childByName.get('camera')?.policy.state, 'blocked');
  assert.equal(childByName.get('camera')?.state, 'denied');
  assert.equal(childByName.get('camera')?.browserState, 'unknown');
  assert.equal(childByName.get('microphone')?.policy.state, 'blocked');
  assert.equal(childByName.get('notifications')?.browserState, 'unknown');
});
