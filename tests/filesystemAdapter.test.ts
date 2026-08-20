import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, link, mkdir, mkdtemp, rename, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ComputerEnvironmentRegistry } from '../src/computer/environmentRegistry.js';
import {
  FilesystemAdapterError,
  FilesystemComputerEnvironmentAdapter,
  type FilesystemDirectoryObservation,
  type FilesystemFileObservation,
  type FilesystemReadDetails,
} from '../src/computer/filesystemAdapter.js';

async function fixture(): Promise<{ root: string; adapter: FilesystemComputerEnvironmentAdapter; cleanup(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'computer-fs-adapter-'));
  return {
    root,
    adapter: new FilesystemComputerEnvironmentAdapter({ adapterId: 'filesystem-test', rootPath: root }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => error instanceof FilesystemAdapterError && error.code === code);
}

test('directory enumeration is deterministic, bounded, and explicitly truncated', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'c.txt'), 'c');
    await mkdir(join(f.root, 'b-dir'));
    await writeFile(join(f.root, 'a.txt'), 'a');
    const { surface, directory } = await f.adapter.root();
    const observed = await f.adapter.observe({
      adapterId: 'filesystem-test',
      channel: 'filesystem',
      surface,
      target: directory,
      limits: { maxItems: 2, maxDepth: 1 },
    });
    const data = observed.data as FilesystemDirectoryObservation;
    assert.deepEqual(data.entries.map((entry) => entry.name), ['a.txt', 'b-dir']);
    assert.deepEqual(data.entries.map((entry) => entry.type), ['file', 'directory']);
    assert.equal(observed.truncated, true);
    assert.equal(observed.complete, false);
    assert.ok(data.entries.every((entry) => entry.ref));
  } finally {
    await f.cleanup();
  }
});

test('directory name/symlink text is bounded independently of maxItems', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'aa'), 'a');
    await writeFile(join(f.root, 'bb'), 'b');
    await writeFile(join(f.root, 'cc'), 'c');
    const { directory } = await f.adapter.root();
    const observed = await f.adapter.observe({
      adapterId: 'filesystem-test',
      channel: 'filesystem',
      target: directory,
      limits: { maxItems: 3, maxTextBytes: 4 },
    });
    const data = observed.data as FilesystemDirectoryObservation;
    assert.deepEqual(data.entries.map((entry) => entry.name), ['aa', 'bb']);
    assert.equal(observed.truncated, true);
    assert.equal(observed.complete, false);
  } finally {
    await f.cleanup();
  }
});

test('file metadata exposes bounded decision metadata and hardlink discovery without content', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'source.txt');
    await writeFile(path, 'hello');
    await link(path, join(f.root, 'alias.txt'));
    const ref = await f.adapter.resolvePath('source.txt');
    const observed = await f.adapter.observe({
      adapterId: 'filesystem-test',
      channel: 'filesystem',
      target: ref,
      limits: { maxTextBytes: 1 },
    });
    const data = observed.data as FilesystemFileObservation;
    assert.equal(data.metadata.type, 'file');
    assert.equal(data.metadata.size, 5);
    assert.equal(data.metadata.hardlinked, true);
    assert.ok(data.metadata.linkCount >= 2);
    assert.equal('content' in data, false);
  } finally {
    await f.cleanup();
  }
});

test('registry-routed metadata observation cannot expose file contents through generic maxTextBytes', async () => {
  const f = await fixture();
  try {
    const secret = 'metadata-must-not-read-this';
    await writeFile(join(f.root, 'private.txt'), secret);
    const ref = await f.adapter.resolvePath('private.txt');
    const registry = new ComputerEnvironmentRegistry();
    registry.register(f.adapter);
    const observed = await registry.observe({
      adapterId: 'filesystem-test',
      channel: 'filesystem',
      target: ref,
      limits: { maxTextBytes: 4 },
    });
    assert.equal(observed.truncated, false);
    assert.equal(JSON.stringify(observed.data).includes(secret), false);
    assert.equal('content' in (observed.data as object), false);
  } finally {
    await f.cleanup();
  }
});

test('bounded UTF-8 reads trim incomplete multibyte code points instead of classifying valid text as binary', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'unicode.txt'), 'A😀B');
    const ref = await f.adapter.resolvePath('unicode.txt');
    const result = await f.adapter.act({
      adapterId: 'filesystem-test',
      actionId: 'unicode-read',
      capability: 'filesystem.read',
      effect: 'observe-only',
      idempotency: 'read-only',
      target: ref,
      payload: { maxBytes: 3 },
    });
    assert.equal(result.status, 'completed');
    const details = result.details as FilesystemReadDetails;
    assert.equal(details.content, 'A');
    assert.equal(details.contentBytes, 1);
    assert.equal(details.totalBytes, Buffer.byteLength('A😀B'));
    assert.equal(details.truncated, true);
  } finally {
    await f.cleanup();
  }
});

test('bounded read details explicitly report total bytes and truncation', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'note.txt'), 'abcdefghij');
    const ref = await f.adapter.resolvePath('note.txt');
    const result = await f.adapter.act({
      adapterId: 'filesystem-test',
      actionId: 'bounded-read',
      capability: 'filesystem.read',
      effect: 'observe-only',
      idempotency: 'read-only',
      target: ref,
      payload: { maxBytes: 4 },
    });
    assert.equal(result.status, 'completed');
    const details = result.details as FilesystemReadDetails;
    assert.deepEqual(details, {
      content: 'abcd',
      contentEncoding: 'utf8',
      contentBytes: 4,
      totalBytes: 10,
      truncated: true,
    });
  } finally {
    await f.cleanup();
  }
});

test('replaced file identity becomes stale instead of following the path', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'target.txt');
    await writeFile(path, 'old');
    const ref = await f.adapter.resolvePath('target.txt');
    await rename(path, join(f.root, 'old.txt'));
    await writeFile(path, 'new');
    await expectCode(
      f.adapter.observe({ adapterId: 'filesystem-test', channel: 'filesystem', target: ref }),
      'filesystem-target-stale',
    );
  } finally {
    await f.cleanup();
  }
});

test('replaced directory identity becomes stale instead of enumerating its replacement', async () => {
  const f = await fixture();
  try {
    const path = join(f.root, 'dir');
    await mkdir(path);
    const ref = await f.adapter.resolvePath('dir');
    await rename(path, join(f.root, 'old-dir'));
    await mkdir(path);
    await expectCode(
      f.adapter.observe({ adapterId: 'filesystem-test', channel: 'filesystem', target: ref }),
      'filesystem-target-stale',
    );
  } finally {
    await f.cleanup();
  }
});

test('hardlink identity retains multiple locators when one link is removed', async () => {
  const f = await fixture();
  try {
    const first = join(f.root, 'first.txt');
    const second = join(f.root, 'second.txt');
    await writeFile(first, 'shared');
    const firstRef = await f.adapter.resolvePath('first.txt');
    await link(first, second);
    const secondRef = await f.adapter.resolvePath('second.txt');
    assert.equal(firstRef.entityId, secondRef.entityId);
    assert.equal(firstRef.generation, secondRef.generation);
    await unlink(first);

    const result = await f.adapter.act({
      adapterId: 'filesystem-test',
      actionId: 'hardlink-read',
      capability: 'filesystem.read',
      effect: 'observe-only',
      idempotency: 'read-only',
      target: secondRef,
      payload: { maxBytes: 16 },
    });
    assert.equal(result.status, 'completed');
    assert.equal((result.details as FilesystemReadDetails).content, 'shared');
  } finally {
    await f.cleanup();
  }
});

test('symlinks are observed explicitly but never silently traversed, including outside-root targets', async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'computer-fs-outside-'));
  try {
    await writeFile(join(outside, 'secret.txt'), 'outside');
    await symlink(outside, join(f.root, 'outside-link'));
    const { directory } = await f.adapter.root();
    const observed = await f.adapter.observe({
      adapterId: 'filesystem-test',
      channel: 'filesystem',
      target: directory,
    });
    const data = observed.data as FilesystemDirectoryObservation;
    const entry = data.entries.find((item) => item.name === 'outside-link');
    assert.equal(entry?.type, 'symlink');
    assert.equal(entry?.ref, undefined);
    assert.equal(entry?.symlink?.targetWithinRoot, false);
    await expectCode(f.adapter.resolvePath('outside-link/secret.txt'), 'filesystem-symlink-rejected');
  } finally {
    await f.cleanup();
    await rm(outside, { recursive: true, force: true });
  }
});

test('path traversal and absolute paths fail closed', async () => {
  const f = await fixture();
  try {
    await expectCode(f.adapter.resolvePath('../escape.txt'), 'filesystem-path-traversal');
    await expectCode(f.adapter.resolvePath(join(f.root, 'absolute.txt')), 'filesystem-path-traversal');
  } finally {
    await f.cleanup();
  }
});

test('missing targets are explicit and inaccessible reads are explicit when permissions are enforceable', async (t) => {
  const f = await fixture();
  try {
    await expectCode(f.adapter.resolvePath('missing.txt'), 'filesystem-target-missing');
    const path = join(f.root, 'locked.txt');
    await writeFile(path, 'locked');
    const ref = await f.adapter.resolvePath('locked.txt');
    await chmod(path, 0o000);
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      t.diagnostic('permission-denied subcase skipped under uid 0');
    } else {
      const result = await f.adapter.act({
        adapterId: 'filesystem-test',
        actionId: 'locked-read',
        capability: 'filesystem.read',
        effect: 'observe-only',
        idempotency: 'read-only',
        target: ref,
        payload: { maxBytes: 8 },
      });
      assert.equal(result.status, 'failed');
      assert.deepEqual(result.evidence, ['filesystem-target-inaccessible']);
    }
    await chmod(path, 0o600);
  } finally {
    await f.cleanup();
  }
});

test('bounded read content stays in direct details and never leaks into generic evidence', async () => {
  const f = await fixture();
  try {
    const secret = 'private-content-marker';
    await writeFile(join(f.root, 'private.txt'), secret);
    const ref = await f.adapter.resolvePath('private.txt');
    const result = await f.adapter.act({
      adapterId: 'filesystem-test',
      actionId: 'read-private',
      capability: 'filesystem.read',
      effect: 'observe-only',
      idempotency: 'read-only',
      target: ref,
      payload: { maxBytes: 64 },
    });
    assert.equal(result.status, 'completed');
    assert.equal(result.dispatch, 'not-dispatched');
    assert.equal(result.verification, 'verified');
    assert.deepEqual(result.evidence, ['filesystem-read-bounded']);
    assert.equal((result.details as FilesystemReadDetails).content, secret);
    assert.equal(JSON.stringify(result.evidence).includes(secret), false);
  } finally {
    await f.cleanup();
  }
});

test('generation mismatch is rejected before observation or read', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'g.txt'), 'generation');
    const ref = await f.adapter.resolvePath('g.txt');
    const stale = { ...ref, generation: (ref.generation ?? 0) + 1 };
    await expectCode(
      f.adapter.observe({ adapterId: 'filesystem-test', channel: 'filesystem', target: stale }),
      'filesystem-generation-mismatch',
    );
    const result = await f.adapter.act({
      adapterId: 'filesystem-test',
      actionId: 'generation-read',
      capability: 'filesystem.read',
      effect: 'observe-only',
      idempotency: 'read-only',
      target: stale,
      payload: { maxBytes: 8 },
    });
    assert.equal(result.status, 'rejected');
    assert.equal(result.dispatch, 'not-dispatched');
    assert.deepEqual(result.evidence, ['filesystem-generation-mismatch']);
  } finally {
    await f.cleanup();
  }
});

test('foreign adapter action envelopes are rejected before filesystem work', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'owned.txt'), 'owned-content');
    const ref = await f.adapter.resolvePath('owned.txt');
    await unlink(join(f.root, 'owned.txt'));

    const result = await f.adapter.act({
      adapterId: 'another-adapter',
      actionId: 'cross-adapter-read',
      capability: 'filesystem.read',
      effect: 'observe-only',
      idempotency: 'read-only',
      target: ref,
      payload: { maxBytes: 64 },
    });

    assert.deepEqual(result, {
      status: 'rejected',
      dispatch: 'not-dispatched',
      verification: 'rejected',
      evidence: ['filesystem-read-request-rejected'],
    });
  } finally {
    await f.cleanup();
  }
});

test('adapter action results remain coherent and mutations are not advertised or dispatched', async () => {
  const f = await fixture();
  try {
    assert.deepEqual(f.adapter.descriptor.capabilities, ['filesystem.read']);
    const result = await f.adapter.act({
      adapterId: 'filesystem-test',
      actionId: 'delete-nope',
      capability: 'filesystem.delete',
      effect: 'local-destructive',
      idempotency: 'non-idempotent',
    });
    assert.deepEqual(result, {
      status: 'unsupported',
      dispatch: 'not-dispatched',
      verification: 'unverified',
      evidence: ['filesystem-capability-unsupported'],
    });
  } finally {
    await f.cleanup();
  }
});