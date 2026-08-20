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

function sendAndExit(message: unknown): void {
  if (typeof process.send !== 'function') process.exit(2);
  process.send(message, () => {
    if (process.connected) process.disconnect();
    process.exit(0);
  });
}

process.once('message', async (raw: unknown) => {
  const message = raw as Partial<RunMessage>;
  if (message.type !== 'run' || typeof message.token !== 'string' || typeof message.moduleUrl !== 'string' || typeof message.exportName !== 'string' || typeof message.inputEncoded !== 'string' || !message.limits) process.exit(2);
  const token = message.token;
  const moduleUrl = message.moduleUrl;
  const exportName = message.exportName;
  const inputEncoded = message.inputEncoded;
  const deadlineEpochMs = message.deadlineEpochMs ?? 0;
  const limits = message.limits;
  const operationId = message.operationId ?? '';
  const diagnostics: string[] = [];
  let diagnosticBytes = 0;
  const diagnostic = (code: string): void => {
    if (!DIAGNOSTIC.test(code)) return;
    const size = byteLength(code);
    if (diagnosticBytes + size > limits.maxDiagnosticBytes) return;
    diagnosticBytes += size;
    diagnostics.push(code);
  };
  try {
    if (Date.now() >= deadlineEpochMs) throw new Error('deadline-expired');
    const parsed = JSON.parse(inputEncoded) as Json;
    const inputCheck = canonicalize(parsed, byteLength(inputEncoded), limits.maxJsonDepth, limits.maxJsonItems);
    const input = deepFreeze(JSON.parse(inputCheck.encoded) as Json);
    let moduleProtocol: string;
    try { moduleProtocol = new URL(moduleUrl).protocol; }
    catch { throw new Error('registered-module-url-invalid'); }
    if (moduleProtocol !== 'file:') throw new Error('registered-module-scheme-rejected');
    const loaded = await import(moduleUrl);
    const exported = loaded[exportName];
    const execute = typeof exported === 'function' ? exported : exported?.execute;
    if (typeof execute !== 'function') throw new Error('registered-export-invalid');
    const context = Object.freeze({ operationId, deadlineEpochMs, limits: Object.freeze({ ...limits }), diagnostic });
    const outputEncoded = await execute(input, context);
    if (Date.now() >= deadlineEpochMs) throw new Error('deadline-expired');
    if (typeof outputEncoded !== 'string') throw new Error('output-not-encoded');
    if (byteLength(outputEncoded) > limits.maxOutputBytes) throw new Error('json-byte-limit');
    const outputParsed = JSON.parse(outputEncoded) as Json;
    const canonical = canonicalize(outputParsed, limits.maxOutputBytes, limits.maxJsonDepth, limits.maxJsonItems);
    sendAndExit({ type: 'result', token, outputEncoded: canonical.encoded, outputHash: sha256(canonical.encoded), byteLength: canonical.byteLength, shape: canonical.shape, diagnostics });
  } catch (error) {
    const code = error instanceof Error ? error.message : 'worker-error';
    sendAndExit({ type: 'error', token, code: code === 'json-byte-limit' ? 'output-limit' : 'execution-failed', diagnostics });
  }
});
