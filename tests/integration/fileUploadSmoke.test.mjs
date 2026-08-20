import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { snapshotInteractiveDom } from '../../dist/src/browser/domSnapshot.js';
import { CdpFileUploadController } from '../../dist/src/browser/fileUploadController.js';

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
  const profile = await mkdtemp(join(tmpdir(), 'upload-profile-'));
  const child = spawn(process.env.CHROMIUM_BIN || '/usr/bin/chromium', [
    '--headless=new', '--no-sandbox',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ], { stdio: 'ignore' });
  const pages = await waitJson(`http://127.0.0.1:${port}/json/list`);
  const page = pages.find((candidate) => candidate.type === 'page' && candidate.webSocketDebuggerUrl);
  if (!page) throw new Error('No Chromium page target');
  const client = new Client(page.webSocketDebuggerUrl);
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

function pageFor(client) {
  const frame = {
    async evaluate(pageFunction) {
      const result = await client.send('Runtime.evaluate', {
        expression: `(${pageFunction.toString()})()`,
        returnByValue: true,
        awaitPromise: true,
      });
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
      }
      return result.result.value;
    },
    parentFrame() { return null; },
  };
  return { frames: () => [frame] };
}

async function value(client, expression) {
  const result = await client.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || 'Runtime.evaluate failed');
  return result.result.value;
}

test('real Chromium exposes upload capability and verifies a backend-node file assignment', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'upload-files-'));
  const file = join(root, 'payload.txt');
  await writeFile(file, 'frontier-upload');
  const { client, child, profile } = await launch();
  t.after(async () => {
    client.close();
    await stop(child, profile);
    await rm(root, { recursive: true, force: true });
  });

  await client.send('Runtime.evaluate', {
    expression: `document.body.innerHTML='<input id="upload" type="file" aria-label="Upload">';
      window.changed = 0;
      document.querySelector('#upload').addEventListener('change', () => window.changed += 1);`,
  });

  const perceived = await snapshotInteractiveDom(pageFor(client));
  const semanticTarget = perceived.find((node) => node.name === 'Upload');
  assert.ok(semanticTarget);
  assert.equal(semanticTarget.capabilities.includes('upload'), true);
  assert.equal(semanticTarget.capabilities.includes('type'), false);
  assert.equal(semanticTarget.capabilities.includes('activate'), false);

  const documentNode = await client.send('DOM.getDocument', { depth: 1 });
  const found = await client.send('DOM.querySelector', {
    nodeId: documentNode.root.nodeId,
    selector: '#upload',
  });
  const described = await client.send('DOM.describeNode', { nodeId: found.nodeId });
  const backendNodeId = described.node.backendNodeId;
  const target = {
    ...semanticTarget,
    id: `backend:${backendNodeId}`,
    backendNodeId,
  };

  const result = await new CdpFileUploadController(client, { allowedRoots: [root] })
    .upload(target, [file]);

  assert.equal(result.status, 'uploaded');
  assert.equal(result.fileCount, 1);
  assert.equal(await value(client, `document.querySelector('#upload').files.length`), 1);
  assert.equal(await value(client, `document.querySelector('#upload').files[0].name`), 'payload.txt');
  assert.equal(await value(client, `document.querySelector('#upload').files[0].text()`), 'frontier-upload');
  assert.equal(await value(client, 'window.changed'), 1);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(JSON.stringify(result).includes(file), false);
});
