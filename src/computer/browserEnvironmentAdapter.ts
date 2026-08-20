import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import type { DocumentContentBlock, DocumentContentSnapshot, DocumentFrameContent, DocumentContentFrameError } from '../browser/documentContent.js';
import type {
  FullscreenElementIdentity,
  FullscreenState,
  MediaElementIdentity,
  MediaElementState,
  MediaObservationError,
  MediaStateSnapshot,
  ObserveMediaStateOptions,
} from '../browser/mediaState.js';
import type { VisualSnapshot } from '../browser/visualObserver.js';
import {
  BrowserComputerEnvironmentAdapter as BrowserComputerEnvironmentAdapterCore,
  type BrowserComputerEnvironmentAdapterOptions,
  type BrowserComputerRuntime,
} from './browserEnvironmentAdapterCore.js';

export * from './browserEnvironmentAdapterCore.js';

const MAX_DOCUMENT_FRAMES = 256;
const MAX_DOCUMENT_ERRORS = 32;
const MAX_VISUAL_BYTES = 2 * 1024 * 1024;
const MAX_MEDIA_ERRORS = 16;
const MAX_MEDIA_ELEMENTS = 64;
const MAX_MEDIA_TEXT_LENGTH = 2048;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function captureRecord(value: unknown, label: string, keys: readonly string[]): Readonly<Record<string, unknown>> {
  if (!isRecord(value)) throw new TypeError(`${label} must be a plain data object`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be a plain data object`);
  const captured = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if (!('value' in descriptor)) throw new TypeError(`${label}.${key} must be a data property`);
    captured[key] = descriptor.value;
  }
  return Object.freeze(captured);
}

function ownValue(record: Readonly<Record<string, unknown>>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(record, key)?.value;
}

function arrayLength(value: unknown, label: string): number {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (!descriptor || !('value' in descriptor) || typeof descriptor.value !== 'number' ||
      !Number.isSafeInteger(descriptor.value) || descriptor.value < 0) {
    throw new TypeError(`${label}.length is invalid`);
  }
  return descriptor.value;
}

function arrayItem(value: unknown, index: number, label: string): unknown {
  if (!Array.isArray(value)) throw new TypeError(`${label} must be an array`);
  const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
  if (!descriptor || !('value' in descriptor)) throw new TypeError(`${label}[${index}] must be a data property`);
  return descriptor.value;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function takeText(value: unknown, remaining: number): { value?: string; bytes: number; truncated: boolean } {
  if (value === undefined) return { bytes: 0, truncated: false };
  if (typeof value !== 'string') throw new TypeError('browser observation text must be a string');
  if (remaining <= 0) return { bytes: 0, truncated: value.length > 0 };
  let output = '';
  let bytes = 0;
  for (const char of value) {
    const size = utf8Bytes(char);
    if (bytes + size > remaining) return { value: output || undefined, bytes, truncated: true };
    output += char;
    bytes += size;
  }
  return { value: output, bytes, truncated: false };
}

function requiredText(value: unknown, remaining: number, label: string): { value: string; bytes: number } {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError(`${label} must be a non-empty string`);
  const captured = takeText(value, remaining);
  if (captured.truncated || captured.value === undefined) throw new TypeError(`${label} exceeds the retained text budget`);
  return { value: captured.value, bytes: captured.bytes };
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new TypeError(`${label} must be finite`);
  return value;
}

function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  return value === undefined ? undefined : finiteNumber(value, label);
}

function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') throw new TypeError(`${label} must be a boolean`);
  return value;
}

function captureRect(value: unknown): Readonly<{ x: number; y: number; width: number; height: number }> | undefined {
  if (value === undefined) return undefined;
  const source = captureRecord(value, 'browser document rect', ['x', 'y', 'width', 'height']);
  return Object.freeze({
    x: finiteNumber(ownValue(source, 'x'), 'browser document rect.x'),
    y: finiteNumber(ownValue(source, 'y'), 'browser document rect.y'),
    width: finiteNumber(ownValue(source, 'width'), 'browser document rect.width'),
    height: finiteNumber(ownValue(source, 'height'), 'browser document rect.height'),
  });
}

const DOCUMENT_KINDS = new Set([
  'heading', 'paragraph', 'list-item', 'definition-term', 'definition-description', 'table-caption',
  'table-cell', 'code', 'quote', 'figcaption', 'link', 'image', 'landmark',
]);

function snapshotDocument(value: unknown, maxBlocks: number, maxTextBytes: number, maxDepth: number): DocumentContentSnapshot {
  const source = captureRecord(value, 'browser document result', ['frames', 'blocks', 'totalTextBytes', 'truncated', 'frameErrors']);
  const sourceFrames = ownValue(source, 'frames');
  const sourceBlocks = ownValue(source, 'blocks');
  const sourceErrors = ownValue(source, 'frameErrors');
  const sourceTruncated = ownValue(source, 'truncated');
  if (typeof sourceTruncated !== 'boolean') throw new TypeError('browser document result.truncated must be a boolean');
  const frameLength = arrayLength(sourceFrames, 'browser document frames');
  const blockLength = arrayLength(sourceBlocks, 'browser document blocks');
  const errorLength = arrayLength(sourceErrors, 'browser document errors');
  const frames: DocumentFrameContent[] = [];
  const blocks: DocumentContentBlock[] = [];
  const frameErrors: DocumentContentFrameError[] = [];
  let retainedTextBytes = 0;
  let blockTextBytes = 0;
  let materialTruncated = frameLength > MAX_DOCUMENT_FRAMES || blockLength > maxBlocks || errorLength > MAX_DOCUMENT_ERRORS;

  for (let index = 0; index < Math.min(frameLength, MAX_DOCUMENT_FRAMES); index += 1) {
    const frame = captureRecord(arrayItem(sourceFrames, index, 'browser document frames'), 'browser document frame', [
      'frameId', 'title', 'language', 'description', 'canonicalUrl', 'includedBlocks', 'browserExtractionTruncated',
    ]);
    const frameId = requiredText(ownValue(frame, 'frameId'), maxTextBytes - retainedTextBytes, 'browser document frame.frameId');
    retainedTextBytes += frameId.bytes;
    const title = takeText(ownValue(frame, 'title'), maxTextBytes - retainedTextBytes);
    retainedTextBytes += title.bytes;
    materialTruncated ||= title.truncated;
    const next: DocumentFrameContent = {
      frameId: frameId.value,
      title: title.value ?? '',
      includedBlocks: 0,
      browserExtractionTruncated: ownValue(frame, 'browserExtractionTruncated') === true,
    };
    if (ownValue(frame, 'browserExtractionTruncated') !== true && ownValue(frame, 'browserExtractionTruncated') !== false) {
      throw new TypeError('browser document frame.browserExtractionTruncated must be a boolean');
    }
    for (const field of ['language', 'description', 'canonicalUrl'] as const) {
      const captured = takeText(ownValue(frame, field), maxTextBytes - retainedTextBytes);
      retainedTextBytes += captured.bytes;
      materialTruncated ||= captured.truncated;
      if (captured.value !== undefined) next[field] = captured.value;
    }
    frames.push(Object.freeze(next));
  }

  for (let index = 0; index < Math.min(blockLength, maxBlocks); index += 1) {
    const block = captureRecord(arrayItem(sourceBlocks, index, 'browser document blocks'), 'browser document block', [
      'id', 'frameId', 'kind', 'tagName', 'depth', 'text', 'level', 'href', 'alt', 'role', 'name',
      'rect', 'rendered', 'inViewport', 'truncated',
    ]);
    const depth = ownValue(block, 'depth');
    if (typeof depth !== 'number' || !Number.isSafeInteger(depth) || depth < 0) throw new TypeError('browser document block.depth is invalid');
    if (depth > maxDepth) { materialTruncated = true; continue; }
    const id = requiredText(ownValue(block, 'id'), maxTextBytes - retainedTextBytes, 'browser document block.id');
    retainedTextBytes += id.bytes;
    const frameId = requiredText(ownValue(block, 'frameId'), maxTextBytes - retainedTextBytes, 'browser document block.frameId');
    retainedTextBytes += frameId.bytes;
    const kind = ownValue(block, 'kind');
    if (typeof kind !== 'string' || !DOCUMENT_KINDS.has(kind)) throw new TypeError('browser document block.kind is invalid');
    const tagName = requiredText(ownValue(block, 'tagName'), maxTextBytes - retainedTextBytes, 'browser document block.tagName');
    retainedTextBytes += tagName.bytes;
    const rendered = ownValue(block, 'rendered');
    const inViewport = ownValue(block, 'inViewport');
    const sourceBlockTruncated = ownValue(block, 'truncated');
    if (typeof rendered !== 'boolean' || typeof inViewport !== 'boolean' || typeof sourceBlockTruncated !== 'boolean') {
      throw new TypeError('browser document block state is invalid');
    }
    const next: DocumentContentBlock = {
      id: id.value,
      frameId: frameId.value,
      kind: kind as DocumentContentBlock['kind'],
      tagName: tagName.value,
      depth,
      rendered,
      inViewport,
      truncated: sourceBlockTruncated,
    };
    const level = ownValue(block, 'level');
    if (level !== undefined) {
      if (typeof level !== 'number' || !Number.isSafeInteger(level) || level < 1) throw new TypeError('browser document block.level is invalid');
      next.level = level;
    }
    const rect = captureRect(ownValue(block, 'rect'));
    if (rect) next.rect = rect;
    for (const field of ['text', 'href', 'alt', 'role', 'name'] as const) {
      const captured = takeText(ownValue(block, field), maxTextBytes - retainedTextBytes);
      retainedTextBytes += captured.bytes;
      blockTextBytes += captured.bytes;
      if (captured.value !== undefined) next[field] = captured.value;
      if (captured.truncated) next.truncated = true;
      materialTruncated ||= captured.truncated;
    }
    materialTruncated ||= next.truncated;
    blocks.push(Object.freeze(next));
  }

  const counts = new Map<string, number>();
  for (const block of blocks) counts.set(block.frameId, (counts.get(block.frameId) ?? 0) + 1);
  for (let index = 0; index < frames.length; index += 1) {
    const frame = frames[index];
    frames[index] = Object.freeze({ ...frame, includedBlocks: counts.get(frame.frameId) ?? 0 });
  }

  for (let index = 0; index < Math.min(errorLength, MAX_DOCUMENT_ERRORS); index += 1) {
    const error = captureRecord(arrayItem(sourceErrors, index, 'browser document errors'), 'browser document error', ['frameId', 'message']);
    const frameId = requiredText(ownValue(error, 'frameId'), maxTextBytes - retainedTextBytes, 'browser document error.frameId');
    retainedTextBytes += frameId.bytes;
    const message = takeText(ownValue(error, 'message'), maxTextBytes - retainedTextBytes);
    retainedTextBytes += message.bytes;
    materialTruncated ||= message.truncated;
    frameErrors.push(Object.freeze({ frameId: frameId.value, message: message.value ?? '' }));
  }

  return Object.freeze({
    frames: Object.freeze(frames) as unknown as DocumentFrameContent[],
    blocks: Object.freeze(blocks) as unknown as DocumentContentBlock[],
    totalTextBytes: blockTextBytes,
    truncated: sourceTruncated || materialTruncated,
    frameErrors: Object.freeze(frameErrors) as unknown as DocumentContentFrameError[],
  });
}

function snapshotVisual(value: unknown, maxBytes: number): VisualSnapshot {
  const source = captureRecord(value, 'browser visual result', ['format', 'mimeType', 'dataBase64', 'byteLength', 'sha256', 'width', 'height']);
  const format = ownValue(source, 'format');
  const mimeType = ownValue(source, 'mimeType');
  const dataBase64 = ownValue(source, 'dataBase64');
  const byteLength = ownValue(source, 'byteLength');
  const sha256 = ownValue(source, 'sha256');
  if (format !== 'png' && format !== 'jpeg' && format !== 'webp') throw new TypeError('browser visual result.format is invalid');
  const expectedMime = format === 'png' ? 'image/png' : format === 'jpeg' ? 'image/jpeg' : 'image/webp';
  if (mimeType !== expectedMime) throw new TypeError('browser visual result.mimeType is invalid');
  if (typeof dataBase64 !== 'string') throw new TypeError('browser visual result.dataBase64 must be a string');
  const maxEncodedLength = Math.ceil(maxBytes / 3) * 4 + 4;
  if (dataBase64.length > maxEncodedLength || dataBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
    throw new TypeError('browser visual result exceeds the encoded byte ceiling or is invalid base64');
  }
  const bytes = Buffer.from(dataBase64, 'base64');
  if (bytes.byteLength > maxBytes) throw new TypeError('browser visual result exceeds maxBytes');
  if (typeof byteLength !== 'number' || !Number.isSafeInteger(byteLength) || byteLength !== bytes.byteLength) {
    throw new TypeError('browser visual result.byteLength is incoherent');
  }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(sha256) || sha256.toLowerCase() !== digest) {
    throw new TypeError('browser visual result.sha256 is incoherent');
  }
  const width = ownValue(source, 'width');
  const height = ownValue(source, 'height');
  for (const [label, dimension] of [['width', width], ['height', height]] as const) {
    if (dimension !== undefined && (typeof dimension !== 'number' || !Number.isSafeInteger(dimension) || dimension < 1)) {
      throw new TypeError(`browser visual result.${label} is invalid`);
    }
  }
  return Object.freeze({
    format,
    mimeType: expectedMime,
    dataBase64,
    byteLength,
    sha256: digest,
    ...(width !== undefined ? { width: width as number } : {}),
    ...(height !== undefined ? { height: height as number } : {}),
  });
}

function boundedMediaText(value: unknown, maxLength: number, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > maxLength) throw new TypeError(`${label} is invalid or exceeds maxTextLength`);
  return value;
}

function snapshotMediaIdentity(value: unknown, maxTextLength: number, fullscreen = false): MediaElementIdentity | FullscreenElementIdentity {
  const source = captureRecord(value, 'browser media identity', fullscreen
    ? ['frameId', 'backendNodeId', 'tagName', 'id', 'ariaLabel']
    : ['frameId', 'backendNodeId', 'ordinal', 'tagName', 'id', 'ariaLabel']);
  const frameId = boundedMediaText(ownValue(source, 'frameId'), maxTextLength, 'browser media identity.frameId');
  const backendNodeId = ownValue(source, 'backendNodeId');
  const tagName = ownValue(source, 'tagName');
  if (!frameId || typeof backendNodeId !== 'number' || !Number.isSafeInteger(backendNodeId) || backendNodeId < 1 || typeof tagName !== 'string' || tagName.length > maxTextLength) {
    throw new TypeError('browser media identity is invalid');
  }
  const id = boundedMediaText(ownValue(source, 'id'), maxTextLength, 'browser media identity.id');
  const ariaLabel = boundedMediaText(ownValue(source, 'ariaLabel'), maxTextLength, 'browser media identity.ariaLabel');
  if (fullscreen) return Object.freeze({ frameId, backendNodeId, tagName, ...(id !== undefined ? { id } : {}), ...(ariaLabel !== undefined ? { ariaLabel } : {}) });
  const ordinal = ownValue(source, 'ordinal');
  if (typeof ordinal !== 'number' || !Number.isSafeInteger(ordinal) || ordinal < 0 ||
      (tagName !== 'audio' && tagName !== 'video' && tagName !== 'unknown')) throw new TypeError('browser media element identity is invalid');
  return Object.freeze({ frameId, backendNodeId, ordinal, tagName, ...(id !== undefined ? { id } : {}), ...(ariaLabel !== undefined ? { ariaLabel } : {}) });
}

function sameMediaIdentity(left: MediaElementIdentity, right: MediaElementIdentity): boolean {
  return left.frameId === right.frameId && left.backendNodeId === right.backendNodeId && left.ordinal === right.ordinal;
}

function snapshotMedia(value: unknown, options: ObserveMediaStateOptions = {}): MediaStateSnapshot {
  const maxMediaElements = Math.max(1, Math.min(MAX_MEDIA_ELEMENTS, Math.floor(options.maxMediaElements ?? 32)));
  const maxTextLength = Math.max(1, Math.min(MAX_MEDIA_TEXT_LENGTH, Math.floor(options.maxTextLength ?? 256)));
  const source = captureRecord(value, 'browser media result', ['media', 'activeMedia', 'activeMediaCount', 'fullscreen', 'truncated', 'errors']);
  const sourceMedia = ownValue(source, 'media');
  const sourceErrors = ownValue(source, 'errors');
  const sourceTruncated = ownValue(source, 'truncated');
  if (typeof sourceTruncated !== 'boolean') throw new TypeError('browser media result.truncated must be a boolean');
  const mediaLength = arrayLength(sourceMedia, 'browser media elements');
  const errorLength = arrayLength(sourceErrors, 'browser media errors');
  let materialTruncated = mediaLength > maxMediaElements || errorLength > MAX_MEDIA_ERRORS;
  const media: MediaElementState[] = [];
  for (let index = 0; index < Math.min(mediaLength, maxMediaElements); index += 1) {
    const item = captureRecord(arrayItem(sourceMedia, index, 'browser media elements'), 'browser media element', [
      'identity', 'playbackState', 'muted', 'volume', 'currentTimeSeconds', 'durationSeconds', 'playbackRate', 'visible',
    ]);
    const identity = snapshotMediaIdentity(ownValue(item, 'identity'), maxTextLength, false) as MediaElementIdentity;
    const playbackState = ownValue(item, 'playbackState');
    if (playbackState !== 'playing' && playbackState !== 'paused' && playbackState !== 'ended' && playbackState !== 'unknown') {
      throw new TypeError('browser media playbackState is invalid');
    }
    const muted = optionalBoolean(ownValue(item, 'muted'), 'browser media muted');
    const visible = optionalBoolean(ownValue(item, 'visible'), 'browser media visible');
    const volume = optionalFiniteNumber(ownValue(item, 'volume'), 'browser media volume');
    if (volume !== undefined && (volume < 0 || volume > 1)) throw new TypeError('browser media volume is invalid');
    const currentTimeSeconds = optionalFiniteNumber(ownValue(item, 'currentTimeSeconds'), 'browser media currentTimeSeconds');
    const durationSeconds = optionalFiniteNumber(ownValue(item, 'durationSeconds'), 'browser media durationSeconds');
    const playbackRate = optionalFiniteNumber(ownValue(item, 'playbackRate'), 'browser media playbackRate');
    if (currentTimeSeconds !== undefined && currentTimeSeconds < 0) throw new TypeError('browser media currentTimeSeconds is invalid');
    if (durationSeconds !== undefined && durationSeconds < 0) throw new TypeError('browser media durationSeconds is invalid');
    if (playbackRate !== undefined && playbackRate <= 0) throw new TypeError('browser media playbackRate is invalid');
    media.push(Object.freeze({
      identity,
      playbackState,
      ...(muted !== undefined ? { muted } : {}),
      ...(volume !== undefined ? { volume } : {}),
      ...(currentTimeSeconds !== undefined ? { currentTimeSeconds } : {}),
      ...(durationSeconds !== undefined ? { durationSeconds } : {}),
      ...(playbackRate !== undefined ? { playbackRate } : {}),
      ...(visible !== undefined ? { visible } : {}),
    }));
  }

  const fullscreenSource = captureRecord(ownValue(source, 'fullscreen'), 'browser fullscreen result', ['pageState', 'owner', 'browserWindowState']);
  const pageState = ownValue(fullscreenSource, 'pageState');
  const browserWindowState = ownValue(fullscreenSource, 'browserWindowState');
  if (pageState !== 'active' && pageState !== 'inactive' && pageState !== 'unknown') throw new TypeError('browser fullscreen pageState is invalid');
  if (browserWindowState !== 'fullscreen' && browserWindowState !== 'not-fullscreen' && browserWindowState !== 'unknown') {
    throw new TypeError('browser fullscreen browserWindowState is invalid');
  }
  const ownerValue = ownValue(fullscreenSource, 'owner');
  const owner = ownerValue === undefined ? undefined : snapshotMediaIdentity(ownerValue, maxTextLength, true) as FullscreenElementIdentity;
  const fullscreen: FullscreenState = Object.freeze({ pageState, ...(owner ? { owner } : {}), browserWindowState });

  const errors: MediaObservationError[] = [];
  for (let index = 0; index < Math.min(errorLength, MAX_MEDIA_ERRORS); index += 1) {
    const error = captureRecord(arrayItem(sourceErrors, index, 'browser media errors'), 'browser media error', ['scope', 'operation', 'frameId', 'message']);
    const scope = ownValue(error, 'scope');
    if (scope !== 'frames' && scope !== 'frame' && scope !== 'media' && scope !== 'fullscreen' && scope !== 'browser-window') {
      throw new TypeError('browser media error.scope is invalid');
    }
    const operation = boundedMediaText(ownValue(error, 'operation'), maxTextLength, 'browser media error.operation');
    const message = boundedMediaText(ownValue(error, 'message'), maxTextLength, 'browser media error.message');
    const frameId = boundedMediaText(ownValue(error, 'frameId'), maxTextLength, 'browser media error.frameId');
    if (!operation || message === undefined) throw new TypeError('browser media error is invalid');
    errors.push(Object.freeze({ scope, operation, ...(frameId !== undefined ? { frameId } : {}), message }));
  }

  const sourceActive = ownValue(source, 'activeMedia');
  let activeMedia: MediaElementIdentity | undefined;
  if (sourceActive !== undefined) {
    const captured = snapshotMediaIdentity(sourceActive, maxTextLength, false) as MediaElementIdentity;
    activeMedia = media.find((item) => item.playbackState === 'playing' && sameMediaIdentity(item.identity, captured))?.identity;
    if (!activeMedia) materialTruncated = true;
  }
  const activeMediaCount = media.filter((item) => item.playbackState === 'playing').length;
  return Object.freeze({
    media: Object.freeze(media) as unknown as MediaElementState[],
    ...(activeMedia ? { activeMedia } : {}),
    activeMediaCount,
    fullscreen,
    truncated: sourceTruncated || materialTruncated,
    errors: Object.freeze(errors) as unknown as MediaObservationError[],
  });
}

function snapshotRuntime(runtime: BrowserComputerRuntime): BrowserComputerRuntime {
  return new Proxy(runtime, {
    get(target, property) {
      if (property === 'documentContentForPage') {
        const method = Reflect.get(target, property, target);
        if (typeof method !== 'function') return undefined;
        return async (targetId: string, options: { maxBlocks?: number; maxTextBytes?: number; maxDepth?: number } = {}) => {
          const result = await method.call(target, targetId, options);
          if (result === undefined) return undefined;
          const maxBlocks = Math.max(1, Math.min(256, Math.floor(options.maxBlocks ?? 128)));
          const maxTextBytes = Math.max(1, Math.min(64 * 1024, Math.floor(options.maxTextBytes ?? 32 * 1024)));
          const maxDepth = Math.max(1, Math.min(32, Math.floor(options.maxDepth ?? 32)));
          return snapshotDocument(result, maxBlocks, maxTextBytes, maxDepth);
        };
      }
      if (property === 'documentContent') {
        const method = Reflect.get(target, property, target);
        if (typeof method !== 'function') return undefined;
        return async (options: { maxBlocks?: number; maxTextBytes?: number; maxDepth?: number } = {}) => {
          const result = await method.call(target, options);
          if (result === undefined) return undefined;
          const maxBlocks = Math.max(1, Math.min(256, Math.floor(options.maxBlocks ?? 128)));
          const maxTextBytes = Math.max(1, Math.min(64 * 1024, Math.floor(options.maxTextBytes ?? 32 * 1024)));
          const maxDepth = Math.max(1, Math.min(32, Math.floor(options.maxDepth ?? 32)));
          return snapshotDocument(result, maxBlocks, maxTextBytes, maxDepth);
        };
      }
      if (property === 'visualSnapshot') {
        const method = Reflect.get(target, property, target);
        if (typeof method !== 'function') return undefined;
        return async (targetId: string | undefined, options: { maxBytes?: number } = {}) => {
          const maxBytes = Math.max(1, Math.min(MAX_VISUAL_BYTES, Math.floor(options.maxBytes ?? MAX_VISUAL_BYTES)));
          const result = await method.call(target, targetId, { ...options, maxBytes });
          return result === undefined ? undefined : snapshotVisual(result, maxBytes);
        };
      }
      if (property === 'mediaSnapshot') {
        const method = Reflect.get(target, property, target);
        if (typeof method !== 'function') return undefined;
        return async (targetId: string | undefined, options: ObserveMediaStateOptions = {}) => {
          const bounded: ObserveMediaStateOptions = {
            ...options,
            maxMediaElements: Math.max(1, Math.min(MAX_MEDIA_ELEMENTS, Math.floor(options.maxMediaElements ?? 32))),
            maxFrames: Math.max(1, Math.min(32, Math.floor(options.maxFrames ?? 16))),
            maxErrors: Math.max(1, Math.min(MAX_MEDIA_ERRORS, Math.floor(options.maxErrors ?? MAX_MEDIA_ERRORS))),
            maxTextLength: Math.max(1, Math.min(MAX_MEDIA_TEXT_LENGTH, Math.floor(options.maxTextLength ?? 256))),
          };
          const result = await method.call(target, targetId, bounded);
          return result === undefined ? undefined : snapshotMedia(result, bounded);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as BrowserComputerRuntime;
}

export class BrowserComputerEnvironmentAdapter extends BrowserComputerEnvironmentAdapterCore {
  constructor(runtime: BrowserComputerRuntime, options: BrowserComputerEnvironmentAdapterOptions = {}) {
    super(snapshotRuntime(runtime), options);
  }
}
