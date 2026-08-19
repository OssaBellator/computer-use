import { createHash } from 'node:crypto';
import type { CdpSessionLike } from './cdpIdentity.js';
import type { Rect } from '../types.js';

export type VisualImageFormat = 'png' | 'jpeg' | 'webp';

export interface VisualCaptureOptions {
  format?: VisualImageFormat;
  /** JPEG/WebP quality in [0,100]. Ignored for PNG. */
  quality?: number;
  /** Main-viewport CSS-pixel crop. */
  clip?: Rect;
  captureBeyondViewport?: boolean;
  /** Fail closed before returning unexpectedly large image payloads. */
  maxBytes?: number;
}

export interface VisualSnapshot {
  format: VisualImageFormat;
  mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  dataBase64: string;
  byteLength: number;
  sha256: string;
  width?: number;
  height?: number;
}

export interface VisualWaitOptions extends VisualCaptureOptions {
  maxSamples?: number;
  pollIntervalMs?: number;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface VisualWaitResult {
  changed: boolean;
  snapshot: VisualSnapshot;
  samples: number;
  elapsedMs: number;
}

const MIME: Record<VisualImageFormat, VisualSnapshot['mimeType']> = {
  png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp',
};
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function normalizedMaxBytes(value: number | undefined): number {
  const maxBytes = value ?? 8 * 1024 * 1024;
  if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('maxBytes must be a positive integer');
  return maxBytes;
}

function validateCaptureOptions(options: VisualCaptureOptions): void {
  if (options.quality !== undefined &&
      (!Number.isInteger(options.quality) || options.quality < 0 || options.quality > 100)) {
    throw new Error('quality must be an integer in [0,100]');
  }
  if (options.clip && (!Number.isFinite(options.clip.x) || !Number.isFinite(options.clip.y) ||
      !Number.isFinite(options.clip.width) || !Number.isFinite(options.clip.height) ||
      options.clip.width <= 0 || options.clip.height <= 0)) {
    throw new Error('clip must contain finite coordinates and positive dimensions');
  }
  normalizedMaxBytes(options.maxBytes);
}

function pngDimensions(bytes: Buffer): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined;
  const signature = '89504e470d0a1a0a';
  if (bytes.subarray(0, 8).toString('hex') !== signature) return undefined;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/**
 * Bounded visual observation for pages whose meaningful state is not fully
 * represented by DOM/accessibility semantics (canvas, paint-only state, etc.).
 * Screenshot bytes are intentionally returned to the caller and may contain
 * sensitive page content; they are never inserted into task traces automatically.
 */
export class CdpVisualObserver {
  constructor(private readonly session: CdpSessionLike) {}

  async capture(options: VisualCaptureOptions = {}): Promise<VisualSnapshot> {
    validateCaptureOptions(options);
    const format = options.format ?? 'png';
    const params: Record<string, unknown> = {
      format,
      captureBeyondViewport: options.captureBeyondViewport ?? false,
    };
    if (format !== 'png' && options.quality !== undefined) params.quality = options.quality;
    if (options.clip) {
      params.clip = { ...options.clip, scale: 1 };
    }
    const result = await this.session.send('Page.captureScreenshot', params) as { data?: string };
    if (typeof result.data !== 'string' || !result.data) throw new Error('Page.captureScreenshot returned no image data');
    const bytes = Buffer.from(result.data, 'base64');
    const maxBytes = normalizedMaxBytes(options.maxBytes);
    if (bytes.byteLength > maxBytes) {
      throw new Error(`screenshot exceeds maxBytes (${bytes.byteLength} > ${maxBytes})`);
    }
    const dimensions = format === 'png' ? pngDimensions(bytes) : undefined;
    return {
      format,
      mimeType: MIME[format],
      dataBase64: result.data,
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      ...(dimensions ?? {}),
    };
  }

  async waitForChange(
    previousSha256: string,
    options: VisualWaitOptions = {},
  ): Promise<VisualWaitResult> {
    if (!/^[a-f0-9]{64}$/i.test(previousSha256)) throw new Error('previousSha256 must be a SHA-256 hex digest');
    const maxSamples = Math.max(1, Math.floor(options.maxSamples ?? 20));
    const pollIntervalMs = Math.max(0, options.pollIntervalMs ?? 50);
    const timeoutMs = Math.max(0, options.timeoutMs ?? 1000);
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? (() => Date.now());
    const startedAt = now();
    let latest: VisualSnapshot | undefined;

    for (let samples = 1; samples <= maxSamples; samples += 1) {
      latest = await this.capture(options);
      const elapsedMs = Math.max(0, now() - startedAt);
      if (latest.sha256 !== previousSha256) {
        return { changed: true, snapshot: latest, samples, elapsedMs };
      }
      if (samples >= maxSamples || elapsedMs >= timeoutMs) {
        return { changed: false, snapshot: latest, samples, elapsedMs };
      }
      await sleep(Math.min(pollIntervalMs, Math.max(0, timeoutMs - elapsedMs)));
    }
    throw new Error('visual wait exhausted without a sample');
  }
}
