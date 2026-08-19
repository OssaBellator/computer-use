import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CdpFileUploadController } from '../src/browser/fileUploadController.js';
import type { CdpSessionLike } from '../src/browser/cdpIdentity.js';
import type { InteractionNode } from '../src/types.js';

function uploadTarget(): InteractionNode {
  return {
    id: 'file',
    frameId: 'main',
    backendNodeId: 7,
    focused: false,
    disabled: false,
    focusable: true,
    clickable: false,
    editable: false,
    scrollable: false,
    capabilities: ['upload'],
    interactionConfidence: 1,
  };
}

class Session implements CdpSessionLike {
  files: string[] = [];
  multiple = true;
  readonly calls: Array<[string, Record<string, unknown>]> = [];

  async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
    this.calls.push([method, params]);
    if (method === 'DOM.resolveNode') return { object: { objectId: 'file-object' } };
    if (method === 'Runtime.callFunctionOn') {
      return {
        result: {
          value: {
            tagName: 'INPUT',
            type: 'file',
            disabled: false,
            multiple: this.multiple,
            fileCount: this.files.length,
          },
        },
      };
    }
    if (method === 'Runtime.releaseObject') return {};
    if (method === 'DOM.setFileInputFiles') {
      this.files = [...params.files as string[]];
      return {};
    }
    throw new Error(`unexpected method: ${method}`);
  }
}

test('file upload canonicalizes an allowed file and verifies browser count', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'upload-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'a.txt');
  await writeFile(file, 'abc');
  const session = new Session();

  const result = await new CdpFileUploadController(session, { allowedRoots: [root] })
    .upload(uploadTarget(), [file]);

  assert.equal(result.status, 'uploaded');
  assert.equal(result.fileCount, 1);
  assert.equal(result.totalBytes, 3);
  assert.equal(session.files.length, 1);
  assert.equal(JSON.stringify(result).includes(root), false);
  assert.equal(JSON.stringify(result).includes(file), false);
});

test('file upload blocks symlink escape before disclosing a path to CDP', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'upload-root-'));
  const outside = await mkdtemp(join(tmpdir(), 'upload-outside-'));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const secret = join(outside, 'secret.txt');
  const link = join(root, 'link.txt');
  await writeFile(secret, 'secret');
  await symlink(secret, link);
  const session = new Session();

  const result = await new CdpFileUploadController(session, { allowedRoots: [root] })
    .upload(uploadTarget(), [link]);

  assert.equal(result.status, 'policy-blocked');
  assert.equal(result.policyReason, 'file 1 is outside allowed roots');
  assert.equal(session.calls.some(([method]) => method === 'DOM.setFileInputFiles'), false);
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes(link), false);
});

test('file upload blocks multiple local files for a single-file input', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'upload-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const first = join(root, 'a.txt');
  const second = join(root, 'b.txt');
  await writeFile(first, 'a');
  await writeFile(second, 'b');
  const session = new Session();
  session.multiple = false;

  const result = await new CdpFileUploadController(session, { allowedRoots: [root] })
    .upload(uploadTarget(), [first, second]);

  assert.equal(result.status, 'policy-blocked');
  assert.equal(result.policyReason, 'target does not allow multiple files');
  assert.equal(session.calls.some(([method]) => method === 'DOM.setFileInputFiles'), false);
});
