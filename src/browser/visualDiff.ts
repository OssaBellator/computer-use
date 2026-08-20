import { inflateSync } from 'node:zlib';
import type { Rect } from '../types.js';
import type { CdpVisualObserver, VisualCaptureOptions, VisualSnapshot } from './visualObserver.js';

export interface VisualDifferenceOptions {
  /** Width/height of motion tiles in decoded image pixels. Defaults to 16. */
  tileSizePx?: number;
  /** Sample one pixel every N pixels in x/y. Defaults to 2. */
  pixelStride?: number;
  /** Per-sampled-pixel RGB mean absolute delta in [0,255]. Defaults to 24. */
  pixelDeltaThreshold?: number;
  /** Fraction of changed sampled pixels required to mark a tile changed. Defaults to 0.05. */
  tileChangedFraction?: number;
  /** Fail closed before allocating unexpectedly large decoded frames. Defaults to 4,194,304 pixels. */
  maxDecodedPixels?: number;
}

export interface VisualDifferenceTile {
  imageRect: Rect;
  changedPixelFraction: number;
  meanAbsoluteDifference: number;
  /** Main-viewport CSS coordinates when the sampler was configured with a clip. */
  viewportRect?: Rect;
}

export interface VisualDifference {
  compatible: boolean;
  changed: boolean;
  width: number;
  height: number;
  sampledPixels: number;
  changedPixelFraction: number;
  meanAbsoluteDifference: number;
  changedTiles: VisualDifferenceTile[];
  /** Bounding box of changed tiles in decoded image pixels. */
  motionBounds?: Rect;
  /** Main-viewport CSS bounding box when the sampler was configured with a clip. */
  viewportMotionBounds?: Rect;
  reason?: 'dimensions-changed';
}

export interface VisualMotionSamplerOptions extends VisualDifferenceOptions {
  capture?: VisualCaptureOptions;
}

export interface VisualMotionSample {
  sequence: number;
  snapshot: VisualSnapshot;
  /** Null for the first sample after construction/reset because no baseline exists yet. */
  difference: VisualDifference | null;
}

interface DecodedPng {
  width: number;
  height: number;
  rgba: Uint8Array;
}

interface TileAccumulator {
  samples: number;
  changed: number;
  totalDelta: number;
}

const PNG_SIGNATURE = '89504e470d0a1a0a';

function positiveInteger(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function fraction(name: string, value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${name} must be in [0,1]`);
  return value;
}

function channelThreshold(value: number): number {
  if (!Number.isFinite(value) || value < 0 || value > 255) {
    throw new Error('pixelDeltaThreshold must be in [0,255]');
  }
  return value;
}

function bytesPerPixel(colorType: number): number {
  if (colorType === 0) return 1;
  if (colorType === 2) return 3;
  if (colorType === 4) return 2;
  if (colorType === 6) return 4;
  throw new Error(`unsupported PNG color type: ${colorType}`);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function decodePng(snapshot: VisualSnapshot, maxDecodedPixels: number): DecodedPng {
  if (snapshot.format !== 'png') throw new Error('visual differencing requires PNG snapshots');
  const bytes = Buffer.from(snapshot.dataBase64, 'base64');
  if (bytes.length < 8 || bytes.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) {
    throw new Error('invalid PNG signature');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let compression = -1;
  let filterMethod = -1;
  let interlace = -1;
  const idat: Buffer[] = [];

  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const next = dataEnd + 4;
    if (next > bytes.length) throw new Error('truncated PNG chunk');
    const type = bytes.toString('ascii', typeStart, dataStart);
    if (type === 'IHDR') {
      if (length !== 13) throw new Error('invalid PNG IHDR length');
      width = bytes.readUInt32BE(dataStart);
      height = bytes.readUInt32BE(dataStart + 4);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      compression = bytes[dataStart + 10];
      filterMethod = bytes[dataStart + 11];
      interlace = bytes[dataStart + 12];
    } else if (type === 'IDAT') {
      idat.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = next;
  }

  if (width < 1 || height < 1 || !idat.length) throw new Error('PNG is missing IHDR/IDAT data');
  if (width * height > maxDecodedPixels) {
    throw new Error(`decoded PNG exceeds maxDecodedPixels (${width * height} > ${maxDecodedPixels})`);
  }
  if (bitDepth !== 8 || compression !== 0 || filterMethod !== 0 || interlace !== 0) {
    throw new Error('visual differencing supports only non-interlaced 8-bit PNG frames');
  }

  const bpp = bytesPerPixel(colorType);
  const rowBytes = width * bpp;
  const inflated = inflateSync(Buffer.concat(idat));
  const expected = height * (rowBytes + 1);
  if (inflated.length !== expected) {
    throw new Error(`unexpected PNG scanline length (${inflated.length} != ${expected})`);
  }

  const raw = new Uint8Array(width * height * bpp);
  for (let y = 0; y < height; y += 1) {
    const inputRow = y * (rowBytes + 1);
    const filter = inflated[inputRow];
    const outputRow = y * rowBytes;
    for (let x = 0; x < rowBytes; x += 1) {
      const value = inflated[inputRow + 1 + x];
      const left = x >= bpp ? raw[outputRow + x - bpp] : 0;
      const up = y > 0 ? raw[outputRow - rowBytes + x] : 0;
      const upLeft = y > 0 && x >= bpp ? raw[outputRow - rowBytes + x - bpp] : 0;
      let predictor = 0;
      if (filter === 1) predictor = left;
      else if (filter === 2) predictor = up;
      else if (filter === 3) predictor = Math.floor((left + up) / 2);
      else if (filter === 4) predictor = paeth(left, up, upLeft);
      else if (filter !== 0) throw new Error(`unsupported PNG filter: ${filter}`);
      raw[outputRow + x] = (value + predictor) & 0xff;
    }
  }

  const rgba = new Uint8Array(width * height * 4);
  for (let source = 0, target = 0; source < raw.length; source += bpp, target += 4) {
    if (colorType === 0) {
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source];
      rgba[target + 2] = raw[source];
      rgba[target + 3] = 255;
    } else if (colorType === 2) {
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source + 1];
      rgba[target + 2] = raw[source + 2];
      rgba[target + 3] = 255;
    } else if (colorType === 4) {
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source];
      rgba[target + 2] = raw[source];
      rgba[target + 3] = raw[source + 1];
    } else {
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source + 1];
      rgba[target + 2] = raw[source + 2];
      rgba[target + 3] = raw[source + 3];
    }
  }
  return { width, height, rgba };
}

function boundsForTiles(tiles: readonly VisualDifferenceTile[]): Rect | undefined {
  if (!tiles.length) return undefined;
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const tile of tiles) {
    left = Math.min(left, tile.imageRect.x);
    top = Math.min(top, tile.imageRect.y);
    right = Math.max(right, tile.imageRect.x + tile.imageRect.width);
    bottom = Math.max(bottom, tile.imageRect.y + tile.imageRect.height);
  }
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function mapRect(rect: Rect, clip: Rect, imageWidth: number, imageHeight: number): Rect {
  const scaleX = clip.width / imageWidth;
  const scaleY = clip.height / imageHeight;
  return {
    x: clip.x + rect.x * scaleX,
    y: clip.y + rect.y * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  };
}

/**
 * Compare two PNG captures without an image-library dependency. The decoder only
 * handles the non-interlaced 8-bit PNG variants produced by Chromium screenshots.
 * Spatial output is a coarse changed-tile map intended for fast game/simulation
 * perception, not photographic similarity scoring.
 */
export function analyzeVisualDifference(
  previous: VisualSnapshot,
  current: VisualSnapshot,
  options: VisualDifferenceOptions = {},
): VisualDifference {
  const tileSizePx = positiveInteger('tileSizePx', options.tileSizePx ?? 16);
  const pixelStride = positiveInteger('pixelStride', options.pixelStride ?? 2);
  const pixelDeltaThreshold = channelThreshold(options.pixelDeltaThreshold ?? 24);
  const tileChangedFraction = fraction('tileChangedFraction', options.tileChangedFraction ?? 0.05);
  const maxDecodedPixels = positiveInteger('maxDecodedPixels', options.maxDecodedPixels ?? 4_194_304);
  const before = decodePng(previous, maxDecodedPixels);
  const after = decodePng(current, maxDecodedPixels);

  if (before.width !== after.width || before.height !== after.height) {
    const full = { x: 0, y: 0, width: after.width, height: after.height };
    return {
      compatible: false,
      changed: true,
      width: after.width,
      height: after.height,
      sampledPixels: 0,
      changedPixelFraction: 1,
      meanAbsoluteDifference: 255,
      changedTiles: [{ imageRect: full, changedPixelFraction: 1, meanAbsoluteDifference: 255 }],
      motionBounds: full,
      reason: 'dimensions-changed',
    };
  }

  const tileColumns = Math.ceil(after.width / tileSizePx);
  const tiles = new Map<number, TileAccumulator>();
  let sampledPixels = 0;
  let changedPixels = 0;
  let totalDelta = 0;

  for (let y = 0; y < after.height; y += pixelStride) {
    for (let x = 0; x < after.width; x += pixelStride) {
      const offset = (y * after.width + x) * 4;
      const delta = (
        Math.abs(after.rgba[offset] - before.rgba[offset]) +
        Math.abs(after.rgba[offset + 1] - before.rgba[offset + 1]) +
        Math.abs(after.rgba[offset + 2] - before.rgba[offset + 2])
      ) / 3;
      const changed = delta >= pixelDeltaThreshold;
      sampledPixels += 1;
      totalDelta += delta;
      if (changed) changedPixels += 1;
      const tileX = Math.floor(x / tileSizePx);
      const tileY = Math.floor(y / tileSizePx);
      const key = tileY * tileColumns + tileX;
      const accumulator = tiles.get(key) ?? { samples: 0, changed: 0, totalDelta: 0 };
      accumulator.samples += 1;
      accumulator.totalDelta += delta;
      if (changed) accumulator.changed += 1;
      tiles.set(key, accumulator);
    }
  }

  const changedTiles: VisualDifferenceTile[] = [];
  for (const [key, accumulator] of tiles) {
    const changedPixelFraction = accumulator.changed / accumulator.samples;
    if (changedPixelFraction < tileChangedFraction) continue;
    const tileX = key % tileColumns;
    const tileY = Math.floor(key / tileColumns);
    const x = tileX * tileSizePx;
    const y = tileY * tileSizePx;
    changedTiles.push({
      imageRect: {
        x,
        y,
        width: Math.min(tileSizePx, after.width - x),
        height: Math.min(tileSizePx, after.height - y),
      },
      changedPixelFraction,
      meanAbsoluteDifference: accumulator.totalDelta / accumulator.samples,
    });
  }
  changedTiles.sort((a, b) => a.imageRect.y - b.imageRect.y || a.imageRect.x - b.imageRect.x);
  const motionBounds = boundsForTiles(changedTiles);
  return {
    compatible: true,
    changed: changedTiles.length > 0,
    width: after.width,
    height: after.height,
    sampledPixels,
    changedPixelFraction: sampledPixels ? changedPixels / sampledPixels : 0,
    meanAbsoluteDifference: sampledPixels ? totalDelta / sampledPixels : 0,
    changedTiles,
    ...(motionBounds ? { motionBounds } : {}),
  };
}

/** Stateful cropped/downscaled visual sampler with coarse spatial motion output. */
export class VisualMotionSampler {
  private previous?: VisualSnapshot;
  private sequence = 0;
  private readonly captureOptions: VisualCaptureOptions;

  constructor(
    private readonly observer: CdpVisualObserver,
    private readonly options: VisualMotionSamplerOptions = {},
  ) {
    this.captureOptions = { ...(options.capture ?? {}), format: 'png' };
  }

  reset(): void {
    this.previous = undefined;
    this.sequence = 0;
  }

  async sample(): Promise<VisualMotionSample> {
    const current = await this.observer.capture(this.captureOptions);
    this.sequence += 1;
    let difference = this.previous
      ? analyzeVisualDifference(this.previous, current, this.options)
      : null;
    this.previous = current;

    const clip = this.captureOptions.clip;
    if (difference && clip) {
      difference = {
        ...difference,
        changedTiles: difference.changedTiles.map((tile) => ({
          ...tile,
          viewportRect: mapRect(tile.imageRect, clip, current.width ?? difference!.width, current.height ?? difference!.height),
        })),
        ...(difference.motionBounds
          ? { viewportMotionBounds: mapRect(
              difference.motionBounds,
              clip,
              current.width ?? difference.width,
              current.height ?? difference.height,
            ) }
          : {}),
      };
    }
    return { sequence: this.sequence, snapshot: current, difference };
  }
}
