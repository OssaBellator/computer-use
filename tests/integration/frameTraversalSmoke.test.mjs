import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { snapshotInteractiveDom } from '../../dist/src/browser/domSnapshot.js';
import { FocusController } from '../../dist/src/controller/focusController.js';
import { CdpInputAdapter } from '../../dist/src/input/cdpInputAdapter.js';

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
  const profile = await mkdtemp(join(tmpdir(), 'frame-traversal-smoke-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const pages = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const target = pages.find((page) => page.type === 'page');
  if (!target?.webSocketDebuggerUrl) throw new Error('No Chromium page target');
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

async function frameTree(client) {
  return (await client.send('Page.getFrameTree')).frameTree;
}

function flattenFrameTree(tree, parentId, out = []) {
  out.push({ frame: tree.frame, parentId });
  for (const child of tree.childFrames ?? []) flattenFrameTree(child, tree.frame.id, out);
  return out;
}

async function pageForFrames(client) {
  const tree = await frameTree(client);
  const descriptors = flattenFrameTree(tree, undefined);
  const framesById = new Map();

  for (const descriptor of descriptors) {
    const world = await client.send('Page.createIsolatedWorld', {
      frameId: descriptor.frame.id,
      worldName: `browser-automation-frame-${descriptor.frame.id}`,
      grantUniveralAccess: true,
    });
    framesById.set(descriptor.frame.id, {
      descriptor,
      contextId: world.executionContextId,
    });
  }

  const frameObjects = new Map();
  for (const [frameId, entry] of framesById) {
    frameObjects.set(frameId, {
      async evaluate(pageFunction) {
        const result = await client.send('Runtime.evaluate', {
          expression: `(${pageFunction.toString()})()`,
          contextId: entry.contextId,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
        return result.result.value;
      },
      url() { return entry.descriptor.frame.url ?? ''; },
      name() { return entry.descriptor.frame.name ?? ''; },
      parentFrame() {
        return entry.descriptor.parentId ? frameObjects.get(entry.descriptor.parentId) ?? null : null;
      },
    });
  }

  const ordered = descriptors.map((descriptor) => frameObjects.get(descriptor.frame.id));
  return { frames: () => ordered };
}

async function value(client, expression, contextId) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    ...(contextId ? { contextId } : {}),
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  return result.result.value;
}

test('real Tab and Shift+Tab produce explicit enter-frame and exit-frame topology', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Page.enable');
  await client.send('Runtime.evaluate', {
    expression: `document.body.innerHTML = '<button id="before">Before</button><iframe id="frame" srcdoc="<input id=&quot;inside&quot; aria-label=&quot;Inside&quot;><button id=&quot;childAfter&quot;>Child after</button>"></iframe><button id="after">After</button>'`,
  });
  for (let i = 0; i < 50; i += 1) {
    const count = (await frameTree(client)).childFrames?.length ?? 0;
    if (count > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  const page = await pageForFrames(client);
  const frames = page.frames();
  assert.equal(frames.length, 2);
  const beforeSnapshot = await snapshotInteractiveDom(page);
  const before = beforeSnapshot.find((node) => node.name === 'Before');
  const inside = beforeSnapshot.find((node) => node.name === 'Inside');
  assert.ok(before && inside);
  assert.equal(inside.parentFrameId, before.frameId);

  await client.send('Runtime.evaluate', { expression: `document.querySelector('#before').focus()` });
  const input = new CdpInputAdapter(client);
  const focus = new FocusController(page, input);

  const entered = await focus.step('forward');
  assert.equal(entered.beforeFocusId, before.id);
  assert.equal(entered.afterFocusId, inside.id);
  const afterEnter = await snapshotInteractiveDom(page);
  const enterEdge = focus.topology.toEdges(afterEnter)
    .find((edge) => edge.from === before.id && edge.to === inside.id);
  assert.ok(enterEdge);
  assert.equal(enterEdge.kind, 'enter-frame');
  assert.equal(enterEdge.keyboardKey, 'Tab');
  assert.equal(await value(client, `document.activeElement.id`), 'frame');

  const exited = await focus.step('backward');
  assert.equal(exited.beforeFocusId, inside.id);
  assert.equal(exited.afterFocusId, before.id);
  const afterExit = await snapshotInteractiveDom(page);
  const exitEdge = focus.topology.toEdges(afterExit)
    .find((edge) => edge.from === inside.id && edge.to === before.id);
  assert.ok(exitEdge);
  assert.equal(exitEdge.kind, 'exit-frame');
  assert.equal(exitEdge.keyboardKey, 'Shift+Tab');
  assert.equal(await value(client, `document.activeElement.id`), 'before');
});
