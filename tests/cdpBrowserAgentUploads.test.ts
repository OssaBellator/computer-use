import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpFileUploadController } from '../src/browser/fileUploadController.js';
import { CdpBrowserAgentEngine } from '../src/engine/cdpBrowserAgentEngine.js';
import type { InteractionEngine } from '../src/engine/interactionEngine.js';
import type { InteractionNode } from '../src/types.js';

function target(): InteractionNode {
  return {
    id: 'file', frameId: 'main', backendNodeId: 9, role: 'input', name: 'Upload',
    focused: false, disabled: false, focusable: true, clickable: false, editable: false,
    scrollable: false, capabilities: ['upload'], interactionConfidence: 1,
  };
}

test('browser-agent facade resolves an unambiguous semantic upload target before file disclosure', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'agent-upload-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'payload.txt');
  await writeFile(file, 'abc');
  const selected: string[] = [];
  const session = {
    async send(method: string, params: Record<string, unknown> = {}) {
      if (method === 'DOM.resolveNode') return { object: { objectId: 'file-object' } };
      if (method === 'Runtime.callFunctionOn') {
        return {
          result: {
            value: {
              tagName: 'INPUT', type: 'file', disabled: false, multiple: false,
              fileCount: selected.length,
            },
          },
        };
      }
      if (method === 'Runtime.releaseObject') return {};
      if (method === 'DOM.setFileInputFiles') {
        selected.splice(0, selected.length, ...(params.files as string[]));
        return {};
      }
      throw new Error(`unexpected method: ${method}`);
    },
  };
  const node = target();
  const interaction = {
    async refresh() { return [node]; },
    async resolveDetailed() {
      return { target: node, candidates: [node], equallyPreferred: [node], ambiguous: false };
    },
    async activate() { return { status: 'verified', target: null }; },
    async typeInto() { return { status: 'verified', target: null }; },
  } as unknown as InteractionEngine;
  const uploads = new CdpFileUploadController(session, { allowedRoots: [root] });
  const engine = new CdpBrowserAgentEngine(
    interaction,
    session,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    uploads,
  );

  const result = await engine.uploadFiles({ name: 'Upload', capability: 'upload' }, [file]);
  assert.equal(result.status, 'uploaded');
  assert.equal(selected.length, 1);
  assert.equal(JSON.stringify(result).includes(file), false);
});

test('browser-agent upload fails closed when semantic resolution is ambiguous', async () => {
  const first = target();
  const second = { ...target(), id: 'file-2', backendNodeId: 10 };
  const interaction = {
    async resolveDetailed() {
      return {
        target: first,
        candidates: [first, second],
        equallyPreferred: [first, second],
        ambiguous: true,
      };
    },
    async refresh() { return [first, second]; },
    async activate() { return { status: 'verified', target: null }; },
    async typeInto() { return { status: 'verified', target: null }; },
  } as unknown as InteractionEngine;
  const session = { async send() { throw new Error('CDP must not be called'); } };
  const uploads = {
    async start() {},
    async upload() { throw new Error('upload must not be called'); },
  } as unknown as CdpFileUploadController;
  const engine = new CdpBrowserAgentEngine(
    interaction,
    session,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    uploads,
  );

  const result = await engine.uploadFiles({ capability: 'upload' }, ['/trusted/file.txt']);
  assert.equal(result.status, 'invalid-target');
});
