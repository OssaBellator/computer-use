import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import test from 'node:test';
import type { DocumentContentSnapshot } from '../src/browser/documentContent.js';
import type { MediaStateSnapshot } from '../src/browser/mediaState.js';
import type { BrowserTargetState } from '../src/browser/targetController.js';
import type { VisualSnapshot } from '../src/browser/visualObserver.js';
import {
  BrowserComputerEnvironmentAdapter,
  type BrowserComputerRuntime,
} from '../src/computer/browserEnvironmentAdapter.js';
import type { InteractionNode } from '../src/types.js';

function noOwnKeys<T extends object>(value: T): T {
  return new Proxy(value, {
    ownKeys() { throw new Error('global ownKeys must not be used'); },
  });
}

class NonSemanticRuntime implements BrowserComputerRuntime {
  readonly target: BrowserTargetState = { targetId: 'page-a', type: 'page', attached: true, sequence: 7 };
  documentResult: DocumentContentSnapshot | undefined;
  visualResult: VisualSnapshot | undefined;
  mediaResult: MediaStateSnapshot | undefined;

  browserTargets(): BrowserTargetState[] { return [{ ...this.target }]; }
  activePageTargetId(): string { return this.target.targetId; }
  targetState() {
    return {
      total: 1,
      pages: 1,
      unattachedPages: 0,
      latestPage: this.target,
      latestUnattachedPage: undefined,
    };
  }
  async documentContent(): Promise<DocumentContentSnapshot | undefined> { return this.documentResult; }
  async documentContentForPage(): Promise<DocumentContentSnapshot | undefined> { return this.documentResult; }
  async visualSnapshot(): Promise<VisualSnapshot | undefined> { return this.visualResult; }
  async mediaSnapshot(): Promise<MediaStateSnapshot | undefined> { return this.mediaResult; }
  async refresh(): Promise<InteractionNode[]> { return []; }
  async activate(): Promise<{ status: string; target: InteractionNode | null }> { return { status: 'target-not-found', target: null }; }
  async typeInto(): Promise<{ status: string; target: InteractionNode | null }> { return { status: 'target-not-found', target: null }; }
}

function documentSnapshot(): DocumentContentSnapshot {
  const frame = noOwnKeys({
    frameId: 'main',
    title: 'Stable title',
    includedBlocks: 2,
    browserExtractionTruncated: false,
  });
  const first = noOwnKeys({
    id: 'main:p:nth-of-type(1)',
    frameId: 'main',
    kind: 'paragraph' as const,
    tagName: 'p',
    depth: 1,
    text: 'first',
    rendered: true,
    inViewport: true,
    truncated: false,
  });
  const second = noOwnKeys({
    id: 'main:p:nth-of-type(2)',
    frameId: 'main',
    kind: 'paragraph' as const,
    tagName: 'p',
    depth: 1,
    text: 'second',
    rendered: true,
    inViewport: true,
    truncated: false,
  });
  return noOwnKeys({
    frames: [frame],
    blocks: [first, second],
    totalTextBytes: 11,
    truncated: false,
    frameErrors: [],
  }) as unknown as DocumentContentSnapshot;
}

function visualSnapshot(): VisualSnapshot {
  const bytes = Buffer.from('stable-visual');
  return noOwnKeys({
    format: 'png' as const,
    mimeType: 'image/png' as const,
    dataBase64: bytes.toString('base64'),
    byteLength: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    width: 10,
    height: 5,
  });
}

function mediaSnapshot(): MediaStateSnapshot {
  const identity = noOwnKeys({
    frameId: 'main',
    backendNodeId: 41,
    ordinal: 0,
    tagName: 'video' as const,
    id: 'video-1',
    ariaLabel: 'Stable video',
  });
  const media = noOwnKeys({
    identity,
    playbackState: 'playing' as const,
    muted: false,
    volume: 1,
    currentTimeSeconds: 5,
    durationSeconds: 30,
    playbackRate: 1,
    visible: true,
  });
  const fullscreen = noOwnKeys({
    pageState: 'inactive' as const,
    browserWindowState: 'not-fullscreen' as const,
  });
  return noOwnKeys({
    media: [media],
    activeMedia: identity,
    activeMediaCount: 1,
    fullscreen,
    truncated: false,
    errors: [],
  }) as unknown as MediaStateSnapshot;
}

test('document observation returns an immutable bounded snapshot independent of runtime mutation', async () => {
  const runtime = new NonSemanticRuntime();
  const live = documentSnapshot();
  runtime.documentResult = live;
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);

  const observed = await adapter.observe({
    adapterId: adapter.descriptor.id,
    channel: 'document',
    surface: adapter.currentSurface(),
    limits: { maxItems: 1, maxTextBytes: 256, maxDepth: 4 },
  });
  const data = observed.data as DocumentContentSnapshot;

  live.blocks[0].text = 'mutated';
  live.truncated = true;
  live.frameErrors.push({ frameId: 'main', message: 'late error' });

  assert.equal(observed.truncated, true);
  assert.equal(observed.complete, false);
  assert.equal(data.blocks.length, 1);
  assert.equal(data.blocks[0].text, 'first');
  assert.equal(data.frames[0].includedBlocks, 1);
  assert.equal(data.frameErrors.length, 0);
  assert.equal(Object.isFrozen(data), true);
  assert.equal(Object.isFrozen(data.blocks), true);
  assert.equal(Object.isFrozen(data.blocks[0]), true);
});

test('visual observation snapshots bounded bytes and coherent digest before returning data', async () => {
  const runtime = new NonSemanticRuntime();
  const live = visualSnapshot();
  runtime.visualResult = live;
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);

  const observed = await adapter.observe({
    adapterId: adapter.descriptor.id,
    channel: 'visual',
    surface: adapter.currentSurface(),
    limits: { maxTextBytes: 1024 },
  });
  const data = observed.data as VisualSnapshot;
  live.dataBase64 = Buffer.from('mutated').toString('base64');
  live.byteLength = 7;
  live.sha256 = '0'.repeat(64);

  assert.equal(data.dataBase64, Buffer.from('stable-visual').toString('base64'));
  assert.equal(data.byteLength, Buffer.byteLength('stable-visual'));
  assert.equal(data.sha256, createHash('sha256').update(Buffer.from('stable-visual')).digest('hex'));
  assert.equal(Object.isFrozen(data), true);
});

test('visual observation rejects producer results whose byte metadata is incoherent', async () => {
  const runtime = new NonSemanticRuntime();
  const live = visualSnapshot();
  live.byteLength += 1;
  runtime.visualResult = live;
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);

  await assert.rejects(
    adapter.observe({ adapterId: adapter.descriptor.id, channel: 'visual', surface: adapter.currentSurface() }),
    /byteLength is incoherent/,
  );
});

test('media observation returns immutable bounded nested data with coherent completeness', async () => {
  const runtime = new NonSemanticRuntime();
  const live = mediaSnapshot();
  live.media.push({
    identity: { frameId: 'main', backendNodeId: 42, ordinal: 1, tagName: 'video' },
    playbackState: 'paused',
    muted: true,
    volume: 0,
    currentTimeSeconds: 0,
    durationSeconds: 30,
    playbackRate: 1,
    visible: false,
  });
  runtime.mediaResult = live;
  const adapter = new BrowserComputerEnvironmentAdapter(runtime);

  const observed = await adapter.observe({
    adapterId: adapter.descriptor.id,
    channel: 'media',
    surface: adapter.currentSurface(),
    limits: { maxItems: 1, maxTextBytes: 64, maxDepth: 2 },
  });
  const data = observed.data as MediaStateSnapshot;
  live.media[0].playbackState = 'paused';
  live.truncated = false;
  live.errors.push({ scope: 'media', operation: 'late', message: 'late error' });

  assert.equal(observed.truncated, true);
  assert.equal(observed.complete, false);
  assert.equal(data.media.length, 1);
  assert.equal(data.media[0].playbackState, 'playing');
  assert.equal(data.activeMediaCount, 1);
  assert.equal(data.errors.length, 0);
  assert.equal(Object.isFrozen(data), true);
  assert.equal(Object.isFrozen(data.media), true);
  assert.equal(Object.isFrozen(data.media[0]), true);
  assert.equal(Object.isFrozen(data.media[0].identity), true);
  assert.equal(Object.isFrozen(data.fullscreen), true);
});
