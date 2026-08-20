import { createHash } from 'node:crypto';

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

interface RunMessage {
  type: 'run';
  token: string;
  operationId: string;
  moduleUrl: string;
  exportName: string;
  inputEncoded: string;
  deadlineEpochMs: number;
  limits: {
    maxOutputBytes: number;
    maxDiagnosticBytes: number;
    maxJsonDepth: number;
    maxJsonItems: number;
    memoryBytesHint?: number;
  };
}

interface Canonicalized { encoded: string; byteLength: number; shape: string }
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);
const DIAGNOSTIC = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

function byteLength(value: string): number { return Buffer.byteLength(value, 'utf8'); }
function sha256(value: string): string { return `sha256-${createHash('sha256').update(value, 'utf8').digest('hex')}`; }

function canonicalize(value: unknown, maxBytes: number, maxDepth: number, maxItems: number): Canonicalized {
  let bytes = 0;
  let items = 0;
  let shape = 'unknown';
  const chunks: string[] = [];
  const append = (chunk: string): void => {
    bytes += byteLength(chunk);
    if (bytes > maxBytes) throw new Error('json-byte-limit');
    chunks.push(chunk);
  };
  const visit = (current: unknown, depth: number): void => {
    if (depth > maxDepth) throw new Error('json-depth-limit');
    items += 1;
    if (items > maxItems) throw new Error('json-item-limit');
    if (current === null) { if (depth === 0) shape = 'null'; append('null'); return; }
    if (typeof current === 'string' || typeof current === 'boolean') { if (depth === 0) shape = typeof current; append(JSON.stringify(current)); return; }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('non-finite-number');
      if (depth === 0) shape = 'number';
      append(Object.is(current, -0) ? '0' : JSON.stringify(current));
      return;
    }
    if (Array.isArray(current)) {
      const descriptors = Object.getOwnPropertyDescriptors(current);
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === 'length') continue;
        if (!/^(0|[1-9][0-9]*)$/.test(key) || descriptor.get || descriptor.set) throw new Error('invalid-array-property');
      }
      if (depth === 0) shape = `array:${current.length}`;
      append('[');
      for (let i = 0; i < current.length; i += 1) {
        if (i > 0) append(',');
        const descriptor = descriptors[String(i)];
        if (!descriptor || !('value' in descriptor)) throw new Error('sparse-array');
        visit(descriptor.value, depth + 1);
      }
      append(']');
      return;
    }
    if (typeof current === 'object') {
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('non-plain-object');
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const keys = Object.keys(descriptors).sort();
      if (depth === 0) shape = `object:${keys.length}`;
      append('{');
      keys.forEach((key, index) => {
        if (FORBIDDEN_KEYS.has(key)) throw new Error('unsafe-object-key');
        const descriptor = descriptors[key];
        if (!descriptor.enumerable || descriptor.get || descriptor.set || !('value' in descriptor)) throw new Error('invalid-object-property');
        if (index > 0) append(',');
        append(JSON.stringify(key)); append(':'); visit(descriptor.value, depth + 1);
      });
      append('}');
      return;
    }
    throw new Error('unsupported-json-type');
  };
  visit(value, 0);
  return { encoded: chunks.join(''), byteLength: bytes, shape };
}

function deepFreeze(value: Json): Json {
  if (value && typeof value === 'object') {
    if (Array.isArray(value)) for (const item of value) deepFreeze(item);
    else for (const item of Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function sendAndClose(message: unknown): void {
  if (typeof process.send !== 'function') return;
  process.send(message, () => {
    if (process.connected) process.disconnect();
  });
}

process.once('message', async (raw: unknown) => {
  const message = raw as Partial<RunMessage>;
  if (message.type !== 'run' || typeof message.token !== 'string' || typeof message.moduleUrl !== 'string' || typeof message.exportName !== 'string' || typeof message.inputEncoded !== 'string' || !message.limits) {
    process.exitCode = 2;
    if (process.connected) process.disconnect();
    return;
  }
  const diagnostics: string[] = [];
  let diagnosticBytes = 0;
  const diagnostic = (code: string): void => {
    if (!DIAGNOSTIC.test(code)) return;
    const size = byteLength(code);
    if (diagnosticBytes + size > message.limits!.maxDiagnosticBytes) return;
    diagnosticBytes += size;
    diagnostics.push(code);
  };
  try {
    if (Date.now() >= (message.deadlineEpochMs ?? 0)) throw new Error('deadline-expired');
    const parsed = JSON.parse(message.inputEncoded) as Json;
    const inputCheck = canonicalize(parsed, byteLength(message.inputEncoded), message.limits.maxJsonDepth, message.limits.maxJsonItems);
    if (inputCheck.encoded !== message.inputEncoded) throw new Error('input-canonical-mismatch');
    const input = deepFreeze(parsed);
    const loaded = await import(message.moduleUrl);
    const exported = loaded[message.exportName];
    const execute = typeof exported === 'function' ? exported : exported?.execute;
    if (typeof execute !== 'function') throw new Error('registered-export-invalid');
    const context = Object.freeze({
      operationId: message.operationId,
      deadlineEpochMs: message.deadlineEpochMs,
      limits: Object.freeze({ ...message.limits }),
      diagnostic,
    });
    const output = await execute(input, context);
    if (Date.now() >= (message.deadlineEpochMs ?? 0)) throw new Error('deadline-expired');
    const canonical = canonicalize(output, message.limits.maxOutputBytes, message.limits.maxJsonDepth, message.limits.maxJsonItems);
    sendAndClose({ type: 'result', token: message.token, outputEncoded: canonical.encoded, outputHash: sha256(canonical.encoded), byteLength: canonical.byteLength, shape: canonical.shape, diagnostics });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'worker-error';
    sendAndClose({ type: 'error', token: message.token, code: code === 'json-byte-limit' ? 'output-limit' : 'execution-failed', diagnostics });
  }
});
