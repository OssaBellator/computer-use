import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { CdpVisualObserver, type VisualSnapshot } from '../src/browser/visualObserver.js';
import { analyzeVisualDifference, VisualMotionSampler } from '../src/browser/visualDiff.js';

const SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');

function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(12 + data.length);
  result.writeUInt32BE(data.length, 0);
  result.write(type, 4, 4, 'ascii');
  data.copy(result, 8);
  // CRC is intentionally zero: the regression decoder validates framing/scanlines,
  // not transport integrity, and Chromium itself supplies valid CRCs in production.
  result.writeUInt32BE(0, 8 + data.length);
  return result;
}

function png(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    scanlines[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const [r, g, b, a] = pixel(x, y);
      const offset = row + 1 + x * 4;
      scanlines[offset] = r;
      scanlines[offset + 1] = g;
      scanlines[offset + 2] = b;
      scanlines[offset + 3] = a;
    }
  }
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(scanlines)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function snapshot(bytes: Buffer, width: number, height: number): VisualSnapshot {
  return {
    format: 'png',
    mimeType: 'image/png',
    dataBase64: bytes.toString('base64'),
    byteLength: bytes.byteLength,
    sha256: '0'.repeat(64),
    width,
    height,
  };
}

test('PNG differencing reports coarse changed tiles and motion bounds', () => {
  const before = snapshot(png(32, 16, () => [0, 0, 0, 255]), 32, 16);
  const after = snapshot(png(32, 16, (x, y) =>
    x >= 16 && x < 24 && y < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]
  ), 32, 16);

  const difference = analyzeVisualDifference(before, after, {
    tileSizePx: 8,
    pixelStride: 1,
    pixelDeltaThreshold: 20,
    tileChangedFraction: 0.5,
  });

  assert.equal(difference.compatible, true);
  assert.equal(difference.changed, true);
  assert.equal(difference.sampledPixels, 512);
  assert.equal(difference.changedPixelFraction, 0.125);
  assert.deepEqual(difference.motionBounds, { x: 16, y: 0, width: 8, height: 8 });
  assert.deepEqual(difference.changedTiles.map((tile) => tile.imageRect), [
    { x: 16, y: 0, width: 8, height: 8 },
  ]);
  assert.equal(difference.changedTiles[0].changedPixelFraction, 1);
});

test('dimension changes fail closed as full-frame visual change', () => {
  const before = snapshot(png(8, 8, () => [0, 0, 0, 255]), 8, 8);
  const after = snapshot(png(16, 8, () => [0, 0, 0, 255]), 16, 8);
  const difference = analyzeVisualDifference(before, after);
  assert.equal(difference.compatible, false);
  assert.equal(difference.changed, true);
  assert.equal(difference.reason, 'dimensions-changed');
  assert.deepEqual(difference.motionBounds, { x: 0, y: 0, width: 16, height: 8 });
});

test('decoded-pixel budget prevents unexpectedly large frame allocation', () => {
  const frame = snapshot(png(16, 16, () => [0, 0, 0, 255]), 16, 16);
  assert.throws(() => analyzeVisualDifference(frame, frame, { maxDecodedPixels: 100 }), /maxDecodedPixels/);
});

test('motion sampler requests scaled crop and maps image tiles back to viewport coordinates', async () => {
  const frames = [
    png(32, 16, () => [0, 0, 0, 255]),
    png(32, 16, (x, y) => x >= 8 && x < 16 && y < 8 ? [255, 255, 255, 255] : [0, 0, 0, 255]),
  ];
  const calls: Array<[string, Record<string, unknown>]> = [];
  let index = 0;
  const session = {
    async send(method: string, params: Record<string, unknown> = {}): Promise<any> {
      calls.push([method, params]);
      assert.equal(method, 'Page.captureScreenshot');
      return { data: frames[Math.min(index++, frames.length - 1)].toString('base64') };
    },
  };
  const sampler = new VisualMotionSampler(new CdpVisualObserver(session), {
    capture: {
      clip: { x: 100, y: 50, width: 64, height: 32 },
      scale: 0.5,
      maxBytes: 100_000,
    },
    tileSizePx: 8,
    pixelStride: 1,
    tileChangedFraction: 0.5,
  });

  const baseline = await sampler.sample();
  const moved = await sampler.sample();

  assert.equal(baseline.difference, null);
  assert.equal(moved.snapshot.width, 32);
  assert.equal(moved.snapshot.height, 16);
  assert.deepEqual((calls[0][1].clip as Record<string, unknown>).scale, 0.5);
  assert.deepEqual(moved.difference?.motionBounds, { x: 8, y: 0, width: 8, height: 8 });
  assert.deepEqual(moved.difference?.viewportMotionBounds, { x: 116, y: 50, width: 16, height: 16 });
  assert.deepEqual(moved.difference?.changedTiles[0].viewportRect, { x: 116, y: 50, width: 16, height: 16 });
});
