import { Buffer } from 'node:buffer';
import type { CdpSessionLike } from './cdpIdentity.js';

export type BrowserClipboardMimeType = 'text/plain' | 'text/html';
export type BrowserClipboardStatus =
  | 'read'
  | 'written'
  | 'unavailable'
  | 'rejected'
  | 'invalid-payload'
  | 'payload-too-large'
  | 'protocol-error';

export interface BrowserClipboardPayload {
  text?: string;
  html?: string;
}

export interface BrowserClipboardReadResult {
  status: BrowserClipboardStatus;
  frameId: string;
  payload?: BrowserClipboardPayload;
  types: BrowserClipboardMimeType[];
  totalBytes: number;
  truncated: boolean;
  /** Browser exception name only; page text and exception messages are not retained. */
  errorName?: string;
}

export interface BrowserClipboardWriteResult {
  status: BrowserClipboardStatus;
  frameId: string;
  types: BrowserClipboardMimeType[];
  totalBytes: number;
  /** Browser exception name only; page text and exception messages are not retained. */
  errorName?: string;
}

export interface BrowserClipboardOptions {
  /** Maximum UTF-8 bytes returned or written across text/plain and text/html. */
  maxTotalBytes?: number;
  /** Maximum UTF-8 bytes returned or written for one supported MIME type. */
  maxBytesPerType?: number;
}

interface RuntimeResult {
  result?: { objectId?: string; value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

interface RawClipboardResult {
  status?: unknown;
  text?: unknown;
  html?: unknown;
  types?: unknown;
  truncated?: unknown;
  errorName?: unknown;
}

const DEFAULT_MAX_TOTAL_BYTES = 32 * 1024;
const DEFAULT_MAX_BYTES_PER_TYPE = 16 * 1024;

function positiveInteger(name: string, value: number | undefined, fallback: number, ceiling: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
  return Math.min(resolved, ceiling);
}

function boundedErrorName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, 64);
}

function truncateUtf8(value: string, maxBytes: number): { value: string; bytes: number; truncated: boolean } {
  const originalBytes = Buffer.byteLength(value, 'utf8');
  if (originalBytes <= maxBytes) return { value, bytes: originalBytes, truncated: false };
  let output = '';
  let bytes = 0;
  for (const character of value) {
    const size = Buffer.byteLength(character, 'utf8');
    if (bytes + size > maxBytes) break;
    output += character;
    bytes += size;
  }
  return { value: output, bytes, truncated: true };
}

function payloadTypes(payload: BrowserClipboardPayload): BrowserClipboardMimeType[] {
  const types: BrowserClipboardMimeType[] = [];
  if (payload.text !== undefined) types.push('text/plain');
  if (payload.html !== undefined) types.push('text/html');
  return types;
}

function payloadBytes(payload: BrowserClipboardPayload): number {
  return (payload.text === undefined ? 0 : Buffer.byteLength(payload.text, 'utf8')) +
    (payload.html === undefined ? 0 : Buffer.byteLength(payload.html, 'utf8'));
}

function validateWritePayload(
  payload: BrowserClipboardPayload,
  maxTotalBytes: number,
  maxBytesPerType: number,
): BrowserClipboardWriteResult['status'] | undefined {
  const types = payloadTypes(payload);
  if (!types.length) return 'invalid-payload';
  if (payload.text !== undefined && Buffer.byteLength(payload.text, 'utf8') > maxBytesPerType) return 'payload-too-large';
  if (payload.html !== undefined && Buffer.byteLength(payload.html, 'utf8') > maxBytesPerType) return 'payload-too-large';
  if (payloadBytes(payload) > maxTotalBytes) return 'payload-too-large';
  return undefined;
}

function throwForException(result: RuntimeResult, operation: string): void {
  if (!result.exceptionDetails) return;
  // Deliberately omit browser exception descriptions because pages can influence them.
  throw new Error(`${operation} failed`);
}

async function createWorld(session: CdpSessionLike, frameId: string): Promise<number> {
  const result = await session.send('Page.createIsolatedWorld', {
    frameId,
    worldName: 'browser-automation-clipboard',
  }) as { executionContextId?: number };
  if (!Number.isInteger(result.executionContextId)) throw new Error('Page.createIsolatedWorld returned no executionContextId');
  return result.executionContextId!;
}

async function globalObject(session: CdpSessionLike, contextId: number): Promise<string> {
  const result = await session.send('Runtime.evaluate', {
    expression: 'globalThis',
    contextId,
    returnByValue: false,
    silent: true,
  }) as RuntimeResult;
  throwForException(result, 'Runtime.evaluate');
  if (typeof result.result?.objectId !== 'string') throw new Error('Runtime.evaluate returned no global object');
  return result.result.objectId;
}

async function releaseObject(session: CdpSessionLike, objectId: string | undefined): Promise<void> {
  if (!objectId) return;
  try { await session.send('Runtime.releaseObject', { objectId }); } catch {}
}

const WRITE_CLIPBOARD_FUNCTION = `async function(payload) {
  if (!navigator.clipboard) return { status: 'unavailable' };
  try {
    const hasText = typeof payload.text === 'string';
    const hasHtml = typeof payload.html === 'string';
    if (!hasText && !hasHtml) return { status: 'invalid-payload' };
    if (hasHtml) {
      if (typeof navigator.clipboard.write !== 'function' || typeof ClipboardItem !== 'function') {
        return { status: 'unavailable' };
      }
      const data = {};
      if (hasText) data['text/plain'] = new Blob([payload.text], { type: 'text/plain' });
      data['text/html'] = new Blob([payload.html], { type: 'text/html' });
      await navigator.clipboard.write([new ClipboardItem(data)]);
    } else {
      if (typeof navigator.clipboard.writeText !== 'function') return { status: 'unavailable' };
      await navigator.clipboard.writeText(payload.text);
    }
    return { status: 'written' };
  } catch (error) {
    return {
      status: 'rejected',
      errorName: String(error && error.name ? error.name : 'Error').slice(0, 64),
    };
  }
}`;

const READ_CLIPBOARD_FUNCTION = `async function(maxTotalBytes, maxBytesPerType) {
  if (!navigator.clipboard) return { status: 'unavailable', types: [], truncated: false };
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const bound = (value, limit) => {
    const bytes = encoder.encode(value);
    if (bytes.byteLength <= limit) return { value, bytes: bytes.byteLength, truncated: false };
    const sliced = bytes.slice(0, limit);
    return { value: decoder.decode(sliced), bytes: sliced.byteLength, truncated: true };
  };
  try {
    let text;
    let html;
    let used = 0;
    let truncated = false;
    const types = [];
    if (typeof navigator.clipboard.read === 'function') {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        for (const type of ['text/plain', 'text/html']) {
          if (!item.types.includes(type)) continue;
          if (type === 'text/plain' && text !== undefined) continue;
          if (type === 'text/html' && html !== undefined) continue;
          const remaining = Math.max(0, maxTotalBytes - used);
          if (remaining === 0) { truncated = true; continue; }
          const blob = await item.getType(type);
          const raw = await blob.text();
          const bounded = bound(raw, Math.min(maxBytesPerType, remaining));
          used += bounded.bytes;
          truncated = truncated || bounded.truncated;
          if (type === 'text/plain') text = bounded.value;
          else html = bounded.value;
          types.push(type);
        }
      }
    } else if (typeof navigator.clipboard.readText === 'function') {
      const raw = await navigator.clipboard.readText();
      const bounded = bound(raw, Math.min(maxBytesPerType, maxTotalBytes));
      text = bounded.value;
      used = bounded.bytes;
      truncated = bounded.truncated;
      types.push('text/plain');
    } else {
      return { status: 'unavailable', types: [], truncated: false };
    }
    return { status: 'read', text, html, types, truncated };
  } catch (error) {
    return {
      status: 'rejected',
      types: [],
      truncated: false,
      errorName: String(error && error.name ? error.name : 'Error').slice(0, 64),
    };
  }
}`;

/**
 * Explicit, bounded browser Clipboard API access. The controller never elevates
 * CDP user activation or mutates browser permission state. Reads can expose OS
 * clipboard contents, so there is deliberately no passive observation method.
 */
export class CdpClipboardController {
  constructor(private readonly session: CdpSessionLike) {}

  async write(
    frameId: string,
    payload: BrowserClipboardPayload,
    options: BrowserClipboardOptions = {},
  ): Promise<BrowserClipboardWriteResult> {
    const maxTotalBytes = positiveInteger('maxTotalBytes', options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 1024 * 1024);
    const maxBytesPerType = Math.min(
      maxTotalBytes,
      positiveInteger('maxBytesPerType', options.maxBytesPerType, DEFAULT_MAX_BYTES_PER_TYPE, 512 * 1024),
    );
    const types = payloadTypes(payload);
    const totalBytes = payloadBytes(payload);
    const invalid = validateWritePayload(payload, maxTotalBytes, maxBytesPerType);
    if (invalid) return { status: invalid, frameId, types, totalBytes };

    let objectId: string | undefined;
    try {
      const contextId = await createWorld(this.session, frameId);
      objectId = await globalObject(this.session, contextId);
      const result = await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: WRITE_CLIPBOARD_FUNCTION,
        arguments: [{ value: payload }],
        awaitPromise: true,
        returnByValue: true,
        silent: true,
      }) as RuntimeResult;
      throwForException(result, 'Runtime.callFunctionOn');
      const raw = (result.result?.value ?? {}) as RawClipboardResult;
      const status = raw.status === 'written' || raw.status === 'unavailable' || raw.status === 'rejected'
        ? raw.status
        : 'protocol-error';
      return {
        status,
        frameId,
        types,
        totalBytes,
        ...(status === 'rejected' ? { errorName: boundedErrorName(raw.errorName) } : {}),
      };
    } catch {
      return { status: 'protocol-error', frameId, types, totalBytes };
    } finally {
      await releaseObject(this.session, objectId);
    }
  }

  async read(
    frameId: string,
    options: BrowserClipboardOptions = {},
  ): Promise<BrowserClipboardReadResult> {
    const maxTotalBytes = positiveInteger('maxTotalBytes', options.maxTotalBytes, DEFAULT_MAX_TOTAL_BYTES, 1024 * 1024);
    const maxBytesPerType = Math.min(
      maxTotalBytes,
      positiveInteger('maxBytesPerType', options.maxBytesPerType, DEFAULT_MAX_BYTES_PER_TYPE, 512 * 1024),
    );

    let objectId: string | undefined;
    try {
      const contextId = await createWorld(this.session, frameId);
      objectId = await globalObject(this.session, contextId);
      const result = await this.session.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: READ_CLIPBOARD_FUNCTION,
        arguments: [{ value: maxTotalBytes }, { value: maxBytesPerType }],
        awaitPromise: true,
        returnByValue: true,
        silent: true,
      }) as RuntimeResult;
      throwForException(result, 'Runtime.callFunctionOn');
      const raw = (result.result?.value ?? {}) as RawClipboardResult;
      if (raw.status === 'unavailable' || raw.status === 'rejected') {
        return {
          status: raw.status,
          frameId,
          types: [],
          totalBytes: 0,
          truncated: false,
          ...(raw.status === 'rejected' ? { errorName: boundedErrorName(raw.errorName) } : {}),
        };
      }
      if (raw.status !== 'read') {
        return { status: 'protocol-error', frameId, types: [], totalBytes: 0, truncated: false };
      }

      let remaining = maxTotalBytes;
      let truncated = raw.truncated === true;
      const payload: BrowserClipboardPayload = {};
      const types: BrowserClipboardMimeType[] = [];
      if (typeof raw.text === 'string' && remaining > 0) {
        const bounded = truncateUtf8(raw.text, Math.min(maxBytesPerType, remaining));
        payload.text = bounded.value;
        remaining -= bounded.bytes;
        truncated = truncated || bounded.truncated;
        types.push('text/plain');
      }
      if (typeof raw.html === 'string' && remaining > 0) {
        const bounded = truncateUtf8(raw.html, Math.min(maxBytesPerType, remaining));
        payload.html = bounded.value;
        remaining -= bounded.bytes;
        truncated = truncated || bounded.truncated;
        types.push('text/html');
      } else if (typeof raw.html === 'string') {
        truncated = true;
      }
      const totalBytes = maxTotalBytes - remaining;
      return {
        status: 'read',
        frameId,
        payload,
        types,
        totalBytes,
        truncated,
      };
    } catch {
      return { status: 'protocol-error', frameId, types: [], totalBytes: 0, truncated: false };
    } finally {
      await releaseObject(this.session, objectId);
    }
  }
}
