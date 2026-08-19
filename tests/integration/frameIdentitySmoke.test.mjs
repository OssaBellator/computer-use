import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { snapshotInteractiveDomWithCdpIdentity } from '../../dist/src/browser/cdpIdentity.js';

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
  const profile = await mkdtemp(join(tmpdir(), 'frame-smoke-'));
  const child = spawn('/usr/bin/chromium', [
    '--headless=new', '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const pages = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const target = pages.find((page) => page.type === 'page');
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

function flatten(tree, out = []) {
  out.push(tree);
  for (const child of tree.childFrames ?? []) flatten(child, out);
  return out;
}

test('identical DOM paths in sibling frames receive distinct stable backend identities', async (t) => {
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
  });

  await client.send('Runtime.evaluate', {
    expression: `document.body.innerHTML='<iframe name="alpha" srcdoc="<button>Same</button>"></iframe><iframe name="beta" srcdoc="<button>Same</button>"></iframe>'`,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));

  const { frameTree } = await client.send('Page.getFrameTree');
  const flat = flatten(frameTree);
  const metadata = new Map();
  for (const item of flat) {
    const { executionContextId } = await client.send('Page.createIsolatedWorld', {
      frameId: item.frame.id,
      worldName: 'browser-automation-test',
    });
    metadata.set(item.frame.id, { item, executionContextId });
  }

  const frames = flat.map((item) => {
    const meta = metadata.get(item.frame.id);
    return {
      async evaluate(pageFunction) {
        const result = await client.send('Runtime.evaluate', {
          expression: `(${pageFunction.toString()})()`,
          contextId: meta.executionContextId,
          returnByValue: true,
          awaitPromise: true,
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
        return result.result.value;
      },
      url() { return item.frame.url; },
      name() { return item.frame.name ?? ''; },
      parentFrame() {
        return item.frame.parentId ? metadata.get(item.frame.parentId)?.frameObject ?? null : null;
      },
    };
  });
  flat.forEach((item, index) => { metadata.get(item.frame.id).frameObject = frames[index]; });

  const nodes = await snapshotInteractiveDomWithCdpIdentity({ frames: () => frames }, client);
  const same = nodes.filter((node) => node.name === 'Same');
  assert.equal(same.length, 2);
  assert.deepEqual(same.map((node) => node.frameId), ['frame-1', 'frame-2']);
  assert.equal(typeof same[0].backendNodeId, 'number');
  assert.equal(typeof same[1].backendNodeId, 'number');
  assert.notEqual(same[0].backendNodeId, same[1].backendNodeId);
});
